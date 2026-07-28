import { AppState, DeviceEventEmitter } from 'react-native';
import type { LLMQueueClass, LLMQueuePriority, LLMQueueState } from './types';

export const LLM_MEMORY_PRESSURE_EVENT = 'ShineWriterMemoryPressure';

const LIMITS: Record<LLMQueueClass, number> = {
  normal: 3,
  pipeline: 3,
  background: 2,
  // Canon batches contain five long-context requests. Keeping two in flight
  // avoids a burst that can exhaust an account's RPM/TPM budget or leave all
  // five requests competing for a provider's worker slots. The remainder stay
  // visible as queued work items and are resumed from their persisted state.
  canon_analysis: 2,
  connection: 1,
  local: 1,
};

const PRIORITY: Record<LLMQueuePriority, number> = {
  manual: 0,
  normal: 1,
  background: 2,
};

export interface LLMQueueOptions {
  taskId?: string;
  queueClass: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
  projectId?: number;
  externalSignal?: AbortSignal;
  onQueueState?: (state: LLMQueueState) => void;
}

export interface LLMTaskQueueDefaults {
  queueClass?: LLMQueueClass;
  queuePriority?: LLMQueuePriority;
}

interface QueueEntry extends LLMQueueOptions {
  sequence: number;
  controller: AbortController;
  operation: (signal: AbortSignal) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  started: boolean;
  settled: boolean;
  cancelHandler?: () => void;
}

export class LLMQueueError extends Error {
  readonly code = 'cancelled';

  constructor(message = '已取消') {
    super(message);
    this.name = 'LLMQueueError';
  }
}

function createTaskId(): string {
  return `llm-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

class LLMRequestScheduler {
  private queue: QueueEntry[] = [];
  private active = new Map<LLMQueueClass, number>();
  private activePipelineProjects = new Set<string>();
  private sequence = 0;
  private lowMemory = false;
  private taskDefaults = new Map<string, LLMTaskQueueDefaults>();

  constructor() {
    try {
      DeviceEventEmitter.addListener(LLM_MEMORY_PRESSURE_EVENT, event => {
        this.setLowMemory(Boolean(event?.lowMemory));
      });
      AppState.addEventListener('change', state => {
        // Android does not provide a matching "memory recovered" callback.
        // Returning to the foreground is the safest point to resume queued work.
        if (state === 'active') this.setLowMemory(false);
      });
    } catch {
      // JS-only tests and older RN runtimes may not expose either emitter.
    }
  }

  enqueue<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    options: LLMQueueOptions,
  ): Promise<T> {
    const taskId = options.taskId || createTaskId();
    const entryOptions = { ...options, taskId };

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        ...entryOptions,
        sequence: ++this.sequence,
        controller: new AbortController(),
        operation: signal => operation(signal),
        resolve: value => resolve(value as T),
        reject,
        started: false,
        settled: false,
      };

      const cancel = () => this.cancelEntry(entry, true);
      entry.cancelHandler = cancel;
      if (entry.externalSignal?.aborted) {
        entry.onQueueState?.('cancelled');
        reject(new LLMQueueError());
        return;
      }
      entry.externalSignal?.addEventListener('abort', cancel, { once: true });
      this.queue.push(entry);
      entry.onQueueState?.('queued');
      this.pump();
    });
  }

  setTaskDefaults(taskId: string, defaults: LLMTaskQueueDefaults): void {
    this.taskDefaults.set(taskId, defaults);
  }

  clearTaskDefaults(taskId: string): void {
    this.taskDefaults.delete(taskId);
  }

  getTaskDefaults(taskId?: string): LLMTaskQueueDefaults | undefined {
    return taskId ? this.taskDefaults.get(taskId) : undefined;
  }

  setLowMemory(value: boolean): void {
    if (this.lowMemory === value) return;
    this.lowMemory = value;
    if (!value) this.pump();
  }

  isLowMemory(): boolean {
    return this.lowMemory;
  }

  getSnapshot(): {
    lowMemory: boolean;
    queued: number;
    active: number;
    taskIds: string[];
  } {
    return {
      lowMemory: this.lowMemory,
      queued: this.queue.length,
      active: Array.from(this.active.values()).reduce(
        (sum, value) => sum + value,
        0,
      ),
      taskIds: this.queue.map(entry => entry.taskId!).filter(Boolean),
    };
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const priorityA = PRIORITY[a.queuePriority || 'normal'];
      const priorityB = PRIORITY[b.queuePriority || 'normal'];
      return priorityA - priorityB || a.sequence - b.sequence;
    });
  }

  private activeCount(queueClass: LLMQueueClass): number {
    return this.active.get(queueClass) || 0;
  }

  private canStart(entry: QueueEntry): boolean {
    if (this.lowMemory) return false;

    const queueClass = entry.queueClass;
    if (this.activeCount(queueClass) >= LIMITS[queueClass]) return false;

    if (queueClass === 'pipeline') {
      const projectKey = String(entry.projectId ?? 'global');
      if (this.activePipelineProjects.has(projectKey)) return false;
      const activeOnline =
        this.activeCount('normal') + this.activeCount('pipeline');
      if (activeOnline >= LIMITS.normal) return false;
    }

    return true;
  }

  private pump(): void {
    this.sortQueue();
    while (!this.lowMemory) {
      const index = this.queue.findIndex(entry => this.canStart(entry));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.start(entry);
    }
  }

  private start(entry: QueueEntry): void {
    entry.started = true;
    this.active.set(entry.queueClass, this.activeCount(entry.queueClass) + 1);
    if (entry.queueClass === 'pipeline') {
      this.activePipelineProjects.add(String(entry.projectId ?? 'global'));
    }
    entry.onQueueState?.('running');

    entry.operation(entry.controller.signal).then(
      value => this.finish(entry, undefined, value),
      error => this.finish(entry, error),
    );
  }

  private finish(entry: QueueEntry, error?: unknown, value?: unknown): void {
    if (entry.settled) return;
    entry.settled = true;
    if (entry.cancelHandler) {
      entry.externalSignal?.removeEventListener('abort', entry.cancelHandler);
    }
    this.active.set(
      entry.queueClass,
      Math.max(0, this.activeCount(entry.queueClass) - 1),
    );
    if (entry.queueClass === 'pipeline') {
      this.activePipelineProjects.delete(String(entry.projectId ?? 'global'));
    }
    if (error === undefined) entry.resolve(value);
    else entry.reject(error);
    this.pump();
  }

  private cancelEntry(entry: QueueEntry, rejectPromise: boolean): void {
    if (entry.settled) return;
    if (!entry.started) {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      entry.settled = true;
      if (entry.cancelHandler) {
        entry.externalSignal?.removeEventListener('abort', entry.cancelHandler);
      }
      entry.onQueueState?.('cancelled');
      if (rejectPromise) entry.reject(new LLMQueueError());
      return;
    }
    entry.controller.abort();
  }
}

export const llmRequestScheduler = new LLMRequestScheduler();

export function scheduleLLMRequest<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: LLMQueueOptions,
): Promise<T> {
  return llmRequestScheduler.enqueue(operation, options);
}

export function setLLMTaskQueueDefaults(
  taskId: string,
  defaults: LLMTaskQueueDefaults,
): void {
  llmRequestScheduler.setTaskDefaults(taskId, defaults);
}

export function clearLLMTaskQueueDefaults(taskId: string): void {
  llmRequestScheduler.clearTaskDefaults(taskId);
}

export function getLLMTaskQueueDefaults(
  taskId?: string,
): LLMTaskQueueDefaults | undefined {
  return llmRequestScheduler.getTaskDefaults(taskId);
}
