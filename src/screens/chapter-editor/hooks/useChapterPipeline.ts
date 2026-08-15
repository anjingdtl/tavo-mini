import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import Toast from 'react-native-toast-message';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { EditorStackParamList } from '../../../navigation/TabNavigator';
import * as db from '../../../services/database';
import {
  cancelPipeline,
} from '../../../services/pipelineRunner';
import {
  createContinuationWritingKernelExecution,
  createOutlineResumeWritingKernelExecution,
  createOutlineWritingKernelExecution,
  runWritingKernel,
  type StageInfo,
} from '../../../services/writing';
import { suppressGlobalPipelinePrompt } from '../../../navigation/pipelinePromptSuppression';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';
import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import { useProjectStore } from '../../../store/projectStore';
import {
  CURRENT_OUTLINE_WORKFLOW_VERSION,
  PHASE2_CONTEXT_BUDGET_VERSION,
} from '../../../services/pipeline/outlineWorkflowVersion';
import { cancelContinuationRun } from '../../../services/continuation/generation';
import { getContinuationChapterNumbering } from '../../../services/continuation/chapterNumbering/continuationChapterNumbering';
import { prepareStoryMemoryForGeneration } from '../../../services/storyMemory/storyMemoryPrepare';
import { enqueueStoryMemoryMaintenance } from '../../../services/storyMemory/storyMemoryService';
import type { Chapter } from '../../../types/novel';
import type {
  PipelineStageName,
  PipelineTask,
  PipelineTaskStatus,
} from '../../../types/pipeline';
import {
  CONTINUATION_STAGE_LABELS,
  CONTINUATION_STAGE_PROGRESS,
  type ContinuationPipelineStage,
} from '../../../components/PipelineProgress';

type ChapterNavigation = NativeStackNavigationProp<
  EditorStackParamList,
  'ChapterEditor'
>;
type RunningPipelineStatus = Extract<
  PipelineTaskStatus,
  | 'idle'
  | 'queued'
  | 'drafting'
  | 'reviewing'
  | 'factChecking'
  | 'briefing'
  | 'proofing'
>;
type CreateTask = (
  targetType: 'chapter' | 'freeform',
  targetId: number,
  versions?: {
    outlineWorkflowVersion: 1 | 2 | 3 | 4;
    contextBudgetVersion: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  },
) => Promise<string>;

const RUNNING_PIPELINE_STATUSES: RunningPipelineStatus[] = [
  'idle',
  'queued',
  'drafting',
  'reviewing',
  'factChecking',
  'briefing',
  'proofing',
];

function stageFromTaskStatus(
  status: RunningPipelineStatus,
): PipelineStageName | 'idle' {
  if (status === 'drafting') return 'draft';
  if (status === 'reviewing') return 'review';
  if (status === 'factChecking') return 'factCheck';
  if (status === 'briefing') return 'brief';
  if (status === 'proofing') return 'proof';
  return 'idle';
}

function isRunningPipelineStatus(
  status: PipelineTaskStatus,
): status is RunningPipelineStatus {
  return RUNNING_PIPELINE_STATUSES.includes(status as RunningPipelineStatus);
}

function continuationStageFromRunStage(
  stage: string | null | undefined,
): ContinuationPipelineStage | null {
  if (
    stage === 'context' ||
    stage === 'writer' ||
    stage === 'auditing' ||
    stage === 'checker' ||
    stage === 'repair'
  ) {
    return stage;
  }
  // V5 physical / local nodes map directly.
  if (
    stage === 'draft_writer' ||
    stage === 'narrative_architect' ||
    stage === 'revision_writer' ||
    stage === 'adversarial_auditor' ||
    stage === 'final_reviser' ||
    stage === 'final_validate'
  ) {
    return stage;
  }
  // V5 writes round-level stages before the concrete child node; map them to
  // the earliest sub-stage so the user sees progress as soon as the round opens.
  if (stage === 'round1') return 'draft_writer';
  if (stage === 'round2') return 'revision_writer';
  if (stage === 'round3') return 'final_reviser';
  return null;
}

interface Params {
  chapter: Chapter | null;
  chapterId: number;
  navigation: ChapterNavigation;
}

export function useChapterPipeline({ chapter, chapterId, navigation }: Params) {
  const [generating, setGenerating] = useState(false);
  const [currentStage, setCurrentStage] = useState<PipelineStageName | 'idle'>(
    'idle',
  );
  const [progressStartedAt, setProgressStartedAt] = useState(Date.now());
  const [progressVisible, setProgressVisible] = useState(false);
  const [queued, setQueued] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [continuationStage, setContinuationStage] =
    useState<ContinuationPipelineStage | null>(null);
  const resultTaskIdRef = useRef<string | null>(null);
  const seenTerminalRef = useRef<Map<string, 'completed' | 'failed'>>(
    new Map(),
  );
  const continuationStageRef = useRef<ContinuationPipelineStage | null>(null);
  // executeRunPipeline is declared before executeResumePipeline because the
  // latter is also used by the "已有失败任务" prompt below. Keep a ref for
  // the terminal failure alert so the timeout dialog can invoke the latest
  // resume closure without reopening the task centre first.
  const resumePipelineRef = useRef<((taskId: string) => Promise<void>) | null>(
    null,
  );

  const openPipelineResult = useCallback(
    (taskId: string) => {
      if (taskId === resultTaskIdRef.current) return;
      resultTaskIdRef.current = taskId;
      setProgressVisible(false);
      setGenerating(false);
      setQueued(false);
      setPreparing(false);
      setContinuationStage(null);
      continuationStageRef.current = null;
      navigation.navigate('PipelineResult', { taskId });
    },
    [navigation],
  );

  const attachRunningPipelineTask = useCallback((task: PipelineTask) => {
    if (!isRunningPipelineStatus(task.status)) return;
    setCurrentStage(stageFromTaskStatus(task.status));
    setProgressStartedAt(task.updatedAt || task.createdAt);
    setProgressVisible(true);
    setGenerating(true);
    setQueued(task.status === 'queued');
    setPreparing(task.status === 'idle' || task.status === 'queued');
  }, []);

  useEffect(() => {
    const findTask = () =>
      usePipelineTaskStore
        .getState()
        .tasks.find(
          task =>
            task.targetType === 'chapter' &&
            task.targetId === chapterId &&
            task.resolvedAt === null &&
            (isRunningPipelineStatus(task.status) ||
              task.status === 'completed' ||
              task.status === 'failed'),
        );
    const handleTerminal = (task: { id: string; status: string }) => {
      const prev = seenTerminalRef.current.get(task.id);
      if (task.status === 'completed') {
        // The result page was already opened for this task — never navigate
        // twice. Auto-retry keeps the SAME task id, so a completed task that
        // later fails/retries must still be handled once per terminal state.
        if (task.id === resultTaskIdRef.current) return;
        if (prev === 'completed') return;
        seenTerminalRef.current.set(task.id, 'completed');
        openPipelineResult(task.id);
      } else if (task.status === 'failed') {
        // A task may fail, be auto-retried/resumed in the background (same
        // id), then complete. Every failure must clear the progress UI; the
        // completed transition afterwards is still processed above because
        // `failed` never claims resultTaskIdRef. Only the FIRST failure may
        // record the state (subsequent identical failures stay silent).
        if (prev === undefined) {
          seenTerminalRef.current.set(task.id, 'failed');
        }
        setProgressVisible(false);
        setGenerating(false);
        setQueued(false);
        setPreparing(false);
      }
    };

    const initial = findTask();
    if (initial) {
      attachRunningPipelineTask(initial);
      if (initial.status === 'completed' || initial.status === 'failed') {
        handleTerminal(initial);
      }
    }

    const unsubscribe = usePipelineTaskStore.subscribe(
      (state, previousState) => {
        if (state.tasks === previousState.tasks) return;
        const task = state.tasks.find(
          current =>
            current.targetType === 'chapter' &&
            current.targetId === chapterId &&
            current.resolvedAt === null &&
            (isRunningPipelineStatus(current.status) ||
              current.status === 'completed' ||
              current.status === 'failed'),
        );
        if (task) {
          attachRunningPipelineTask(task);
          handleTerminal(task);
        }
      },
    );
    return unsubscribe;
  }, [attachRunningPipelineTask, chapterId, openPipelineResult]);

  useEffect(() => {
    const seenTerminal = seenTerminalRef.current;
    return () => seenTerminal.clear();
  }, []);

  const showPipelineFailureAlert = useCallback(
    (taskId: string, message: string) => {
      Alert.alert('流水线失败', message, [
        { text: '稍后处理', style: 'cancel' },
        {
          text: '查看任务详情',
          onPress: () =>
            navigation.navigate('PipelineResult', {
              taskId,
            }),
        },
        {
          text: '从失败处继续重跑',
          onPress: () => {
            const resume = resumePipelineRef.current;
            if (resume) {
              resume(taskId).catch(() => undefined);
            }
          },
        },
      ]);
    },
    [navigation],
  );

  const executeRunPipeline = useCallback(
    async (createTask: CreateTask) => {
      if (!chapter) return;
      setGenerating(true);
      setProgressVisible(true);
      setPreparing(true);
      // Persist the parent task + pending checkpoints atomically BEFORE
      // starting the foreground service or reconcile. If the DB write fails
      // we surface a "无法启动流水线" error and never call the model — the
      // failure happens before any LLM request is made.
      let taskId: string;
      try {
        // §4.2: NEW outline chapter tasks freeze the CURRENT protocol
        // versions explicitly at creation; non-outline / freeform /
        // pseudo-chapters stay Legacy (V1).
        //
        // New outline chapter tasks use the unified V3 allocator. Historical
        // V2 tasks remain frozen and resume on their own version.
        const project = useProjectStore.getState().currentProject;
        const isOutlineChapter = project?.mode === 'outline' && chapter.id > 0;
        const contextBudgetVersion = isOutlineChapter
          ? PHASE2_CONTEXT_BUDGET_VERSION
          : 1;
        taskId = await createTask('chapter', chapter.id, {
          outlineWorkflowVersion: isOutlineChapter
            ? CURRENT_OUTLINE_WORKFLOW_VERSION
            : 1,
          contextBudgetVersion,
        });
      } catch (error: any) {
        setProgressVisible(false);
        setQueued(false);
        setGenerating(false);
        setPreparing(false);
        console.warn(
          '[useChapterPipeline] PIPELINE_TASK_CREATE_FAILED',
          'chapterId=',
          chapter.id,
          'code=',
          error?.code,
          'message=',
          error?.message,
        );
        Alert.alert(
          '无法启动流水线',
          '写作任务未能保存到本地数据库，因此没有调用模型。\n请重试；如仍然失败，请重新打开应用后检查数据库状态。',
        );
        return;
      }
      suppressGlobalPipelinePrompt(taskId);
      requestNotificationPermission()
        .then(async granted => {
          const available = granted && (await PipelineForeground.isAvailable());
          if (!available) {
            Toast.show({
              type: 'info',
              text1: '未开启通知权限',
              text2: '后台写作会继续尝试运行，但无法显示进度和完成提醒。',
            });
          }
        })
        .catch(() => undefined);
      try {
        const kernelExecution = createOutlineWritingKernelExecution({
          taskId,
          chapter,
          onStageUpdate: (info: StageInfo | string) => {
            if (typeof info === 'object') {
              setPreparing(info.stage === 'idle');
              setCurrentStage(info.stage);
              setProgressStartedAt(info.startedAt);
            }
          },
        });
        await runWritingKernel(kernelExecution);
        setProgressVisible(false);
        setQueued(false);
        setPreparing(false);
        const finishedTask = usePipelineTaskStore
          .getState()
          .tasks.find(task => task.id === taskId);
        if (finishedTask?.status === 'completed') {
          openPipelineResult(taskId);
        } else if (finishedTask?.status === 'failed') {
          showPipelineFailureAlert(taskId, finishedTask.error || '未知错误');
        }
      } catch (error: any) {
        setProgressVisible(false);
        setQueued(false);
        setPreparing(false);
        const failedTask = usePipelineTaskStore
          .getState()
          .tasks.find(task => task.id === taskId && task.status === 'failed');
        if (failedTask) {
          showPipelineFailureAlert(
            taskId,
            failedTask.error || error?.message || '请检查 API 配置。',
          );
        } else {
          Alert.alert('流水线异常', error?.message || '请检查 API 配置。');
        }
      } finally {
        setGenerating(false);
        setPreparing(false);
      }
    },
    [chapter, openPipelineResult, showPipelineFailureAlert],
  );

  // 等价于 executeRunPipeline，但复用现有 failed/interrupted 任务并调 resumePipeline。
  // 把这个先于 runPipeline 定义，以便在 Alert.onPress 回调里可闭包引用，同时避免
  // TDZ / useCallback-deps-before-declaration 的 TS 错误。
  const executeResumePipeline = useCallback(
    async (taskId: string) => {
      if (!chapter) return;
      setGenerating(true);
      setProgressVisible(true);
      setQueued(false);
      setPreparing(false);
      suppressGlobalPipelinePrompt(taskId);
      requestNotificationPermission()
        .then(async granted => {
          const available = granted && (await PipelineForeground.isAvailable());
          if (!available) {
            Toast.show({
              type: 'info',
              text1: '未开启通知权限',
              text2: '后台写作会继续尝试运行，但无法显示进度和完成提醒。',
            });
          }
        })
        .catch(() => undefined);
      try {
        // Resume 前重置所有 failed/interrupted 阶段的检查点：determineNextPipelineAction
        // 看到 status='failed' 会返回 blocked、不会重试，重置为 'pending' 才能让状态机
        // 重新运行该阶段（已成功的 stage 不受影响，仍会被跳过）。
        const checkpoints = await db.getStageCheckpoints(taskId);
        const failedOrInterrupted = checkpoints.filter(
          cp => cp.status === 'failed' || cp.status === 'interrupted',
        );
        for (const cp of failedOrInterrupted) {
          await db.upsertStageCheckpoint({
            taskId,
            stage: cp.stage,
            status: 'pending',
            errorCode: null,
            errorMessage: null,
            bumpAttempt: false,
          });
        }
        const kernelExecution = createOutlineResumeWritingKernelExecution({
          taskId,
          chapter,
          onStageUpdate: (info: StageInfo | string) => {
            if (typeof info === 'object') {
              setPreparing(info.stage === 'idle');
              setCurrentStage(info.stage);
              setProgressStartedAt(info.startedAt);
            }
          },
        });
        await runWritingKernel(kernelExecution);
        setProgressVisible(false);
        setQueued(false);
        const finishedTask = usePipelineTaskStore
          .getState()
          .tasks.find(task => task.id === taskId);
        if (finishedTask?.status === 'completed') {
          openPipelineResult(taskId);
        } else if (finishedTask?.status === 'failed') {
          showPipelineFailureAlert(taskId, finishedTask.error || '未知错误');
        }
      } catch (error: any) {
        setProgressVisible(false);
        setQueued(false);
        setPreparing(false);
        const failedTask = usePipelineTaskStore
          .getState()
          .tasks.find(task => task.id === taskId && task.status === 'failed');
        if (failedTask) {
          showPipelineFailureAlert(
            taskId,
            failedTask.error || error?.message || '请检查 API 配置。',
          );
        } else {
          Alert.alert('流水线异常', error?.message || '请检查 API 配置。');
        }
      } finally {
        setGenerating(false);
        setPreparing(false);
      }
    },
    [chapter, openPipelineResult, showPipelineFailureAlert],
  );

  resumePipelineRef.current = executeResumePipeline;

  const continuationRunIdRef = useRef<string | null>(null);

  const runContinuation = useCallback(async () => {
    if (!chapter) return;
    const project = useProjectStore.getState().currentProject;
    if (!project) {
      Alert.alert('无法续写', '未选择项目。');
      return;
    }
    setGenerating(true);
    setProgressVisible(true);
    setProgressStartedAt(Date.now());
    setCurrentStage('draft');
    setQueued(false);
    setPreparing(false);
    setContinuationStage('context');
    continuationStageRef.current = 'context';
    try {
      await requestNotificationPermission();
      const numbering = await getContinuationChapterNumbering(project.id);
      const instruction =
        chapter.synopsis?.trim() ||
        `续写${numbering.getDefaultTitle(
          chapter.position as any,
        )}，保持与前文一致。`;
      const kernelExecution = createContinuationWritingKernelExecution({
        projectId: project.id,
        chapterId: chapter.id,
        targetPosition: chapter.position,
        userInstruction: instruction,
        currentChapterContent: chapter.content ?? '',
      });
      const { result: run } = await runWritingKernel(kernelExecution);
      continuationRunIdRef.current = run.id;
      const updateContinuationStage = (stage: string | null | undefined) => {
        const next = continuationStageFromRunStage(stage);
        if (!next || continuationStageRef.current === next) return;
        continuationStageRef.current = next;
        setContinuationStage(next);
        setProgressStartedAt(Date.now());
        void PipelineForeground.updateProgress(
          run.id,
          CONTINUATION_STAGE_LABELS[next],
          CONTINUATION_STAGE_PROGRESS[next],
        );
      };
      updateContinuationStage(run.stage);
      try {
        await PipelineForeground.start(
          run.id,
          'AI 续写进行中',
          CONTINUATION_STAGE_LABELS[
            continuationStageFromRunStage(run.stage) ?? 'context'
          ],
          CONTINUATION_STAGE_PROGRESS[
            continuationStageFromRunStage(run.stage) ?? 'context'
          ],
        );
      } catch {
        // foreground optional
      }
      // Poll until awaiting_user / terminal
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        const { getRunById } = await import(
          '../../../services/continuation/generation'
        );
        const latest = await getRunById(run.id);
        if (!latest) break;
        updateContinuationStage(latest.stage);
        if (
          latest.state === 'awaiting_user' ||
          latest.state === 'completed' ||
          latest.state === 'failed' ||
          latest.state === 'cancelled' ||
          latest.state === 'outdated'
        ) {
          try {
            await PipelineForeground.stop(run.id);
          } catch {
            // ignore
          }
          setProgressVisible(false);
          setGenerating(false);
          setPreparing(false);
          setContinuationStage(null);
          continuationStageRef.current = null;
          if (latest.state === 'failed') {
            Alert.alert('续写失败', latest.errorMessage || '未知错误');
          } else if (latest.state === 'cancelled') {
            // stopPipeline may already have toasted; keep a single soft notice.
            Toast.show({ type: 'info', text1: '已取消续写' });
          } else if (
            latest.state === 'awaiting_user' ||
            latest.state === 'completed'
          ) {
            // Never navigate after user cancel / outdated.
            navigation.navigate('ContinuationResult', { runId: run.id });
          }
          return;
        }
        await new Promise(r => setTimeout(r, 800));
      }
      setProgressVisible(false);
      setGenerating(false);
      setPreparing(false);
      setContinuationStage(null);
      continuationStageRef.current = null;
    } catch (error: any) {
      setProgressVisible(false);
      setGenerating(false);
      setPreparing(false);
      setContinuationStage(null);
      continuationStageRef.current = null;
      Alert.alert('续写异常', error?.message || '请检查 Canon/API 配置。');
    }
  }, [chapter, navigation]);

  const runPipeline = useCallback(() => {
    if (!chapter) return;
    const project = useProjectStore.getState().currentProject;
    if (project?.mode === 'continuation') {
      Alert.alert('AI 续写', '将基于 Canon 与续写状态生成本章，是否继续？', [
        { text: '取消', style: 'cancel' },
        {
          text: '开始续写',
          onPress: () => runContinuation().catch(() => {}),
        },
      ]);
      return;
    }
    const { createTask, getActiveTaskForTarget, getLatestResumableFailedTask } =
      usePipelineTaskStore.getState();
    const existing = getActiveTaskForTarget('chapter', chapter.id);
    if (existing) {
      Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
      return;
    }
    // Story Memory readiness is local-only. Safe coverage proceeds without a
    // modal; only a real historical hard gap blocks the writing action.
    const confirmDegraded = async (proceed: () => void) => {
      try {
        const contextConfig = await db.getContextConfig();
        const prepared = await prepareStoryMemoryForGeneration(
          project!.id,
          chapter,
          contextConfig,
          { mode: 'preview' },
        );
        if (prepared.fatal || prepared.hardGap) {
          if (prepared.hardGap || prepared.maintenanceDue) {
            enqueueStoryMemoryMaintenance({
              projectId: project!.id,
              throughPosition: Math.max(-1, chapter.position - 1),
              reason: 'coverage_gap',
              priority: 'background',
            });
            Toast.show({
              type: 'info',
              text1: '故事长期记忆覆盖不足',
              text2: '已在后台开始整理，完成后可重新生成。',
            });
          }
          Alert.alert(
            '暂不能安全生成',
            prepared.blockReason ||
              '历史章节存在未覆盖的信息，长期记忆正在整理。',
            [
              {
                text: '查看故事记忆',
                onPress: () => navigation.navigate('StoryMemory'),
              },
              { text: '稍后重试', style: 'cancel' },
            ],
          );
          return;
        }
        // Safe Coverage: proceed immediately. The generation-mode context
        // preparation has already queued background maintenance.
        proceed();
      } catch {
        // An unavailable readiness probe is not evidence of a Hard Gap. The
        // generation context performs its own local fail-closed validation.
        proceed();
      }
    };
    const resumable = getLatestResumableFailedTask('chapter', chapter.id);
    if (resumable) {
      const isCurrentTask =
        Number(resumable.outlineWorkflowVersion) ===
        CURRENT_OUTLINE_WORKFLOW_VERSION;
      if (!isCurrentTask) {
        Alert.alert(
          '旧版流水线已停止恢复',
          '检测到旧版未完成任务。它仍可查看历史结果，但不能继续执行；按新版重新生成会创建新的完整流水线任务，旧任务和已完成数据会保留。',
          [
            { text: '查看任务详情', onPress: () => navigation.navigate('PipelineResult', { taskId: resumable.id }) },
            {
              text: '按新版重新生成',
              onPress: () =>
                confirmDegraded(() =>
                  executeRunPipeline(createTask).catch(() => {}),
                ),
            },
            { text: '取消', style: 'cancel' },
          ],
        );
        return;
      }
      Alert.alert(
        '从上次失败阶段继续',
        '检测到上一次流水线进度。选「继续」将复用已完成的检查点，只重跑剩余阶段，避免浪费 API 用量；也可以先查看任务详情确认失败原因。',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '查看任务详情',
            onPress: () =>
              navigation.navigate('PipelineResult', {
                taskId: resumable.id,
              }),
          },
          {
            text: '从头开始',
            onPress: () =>
              confirmDegraded(() =>
                executeRunPipeline(createTask).catch(() => {}),
              ),
          },
          {
            text: '继续',
            onPress: () =>
              confirmDegraded(() =>
                executeResumePipeline(resumable.id).catch(() => {}),
              ),
          },
        ],
      );
      return;
    }
    if (chapter.content.trim()) {
      Alert.alert(
        '覆盖并重新生成',
        '当前章节已有正文内容，AI 流水线将覆盖现有正文生成新版本（不会续写到末尾）。确定继续？',
        [
          { text: '取消', style: 'cancel' },
          {
            text: '覆盖并生成',
            onPress: () =>
              confirmDegraded(() =>
                executeRunPipeline(createTask).catch(() => {}),
              ),
          },
        ],
      );
    } else {
      confirmDegraded(() => executeRunPipeline(createTask).catch(() => {}));
    }
  }, [
    chapter,
    executeRunPipeline,
    executeResumePipeline,
    runContinuation,
    navigation,
  ]);

  const stopPipeline = useCallback(() => {
    // Stop must never throw into the toolbar onPress — an uncaught exception
    // here has been observed to tear down the whole RN activity on Android.
    try {
      setGenerating(false);
      setProgressVisible(false);
      setQueued(false);
      setPreparing(false);
      setContinuationStage(null);
      continuationStageRef.current = null;
      if (continuationRunIdRef.current) {
        const rid = continuationRunIdRef.current;
        continuationRunIdRef.current = null;
        void (async () => {
          try {
            await cancelContinuationRun(rid);
          } catch (error) {
            console.warn('[continuation] stop cancelContinuationRun:', error);
          } finally {
            try {
              await PipelineForeground.stop(rid);
            } catch {
              // optional foreground service
            }
          }
        })();
        Toast.show({ type: 'info', text1: '正在停止续写…' });
        return;
      }
      const runningTask = usePipelineTaskStore
        .getState()
        .tasks.find(
          task =>
            task.targetType === 'chapter' &&
            task.targetId === chapterId &&
            isRunningPipelineStatus(task.status) &&
            task.resolvedAt === null,
        );
      if (runningTask) {
        try {
          cancelPipeline(runningTask.id);
        } catch (error) {
          console.warn('[pipeline] stop cancelPipeline:', error);
        }
      }
    } catch (error) {
      console.warn('[pipeline] stopPipeline failed:', error);
    }
  }, [chapterId]);

  return {
    currentStage,
    generating,
    progressStartedAt,
    progressVisible,
    queued,
    preparing,
    continuationStage,
    runPipeline,
    stopPipeline,
  };
}
