export interface DebouncedAsync<TArgs extends unknown[]> {
  call: (...args: TArgs) => void;
  flush: () => Promise<void>;
  cancel: () => void;
  pending: () => boolean;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  delay: number,
  onError?: (error: unknown) => void,
): DebouncedAsync<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestArgs: TArgs | null = null;
  let running: Promise<void> | null = null;

  const execute = async () => {
    if (!latestArgs) return;
    const args = latestArgs;
    latestArgs = null;
    if (timer) clearTimeout(timer);
    timer = null;
    running = Promise.resolve(fn(...args));
    try {
      await running;
    } finally {
      running = null;
    }
  };

  // 仅在 call（后台自动保存）路径上接住错误并转交 onError，避免错误被静默吞掉。
  // flush 路径仍保留错误传播（调用方主动等待，应当感知失败）。
  const handleBackgroundError = (error: unknown) => {
    if (!onError) return;
    try {
      onError(error);
    } catch {
      /* onError 自身失败则忽略 */
    }
  };

  return {
    call: (...args) => {
      latestArgs = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { execute().catch(handleBackgroundError); }, delay);
    },
    flush: async () => {
      if (running) await running;
      if (latestArgs) await execute();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      latestArgs = null;
    },
    pending: () => latestArgs !== null || running !== null,
  };
}
