import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import Toast from 'react-native-toast-message';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { EditorStackParamList } from '../../../navigation/TabNavigator';
import {
  cancelPipeline,
  runChapterPipeline,
  type StageInfo,
} from '../../../services/pipelineRunner';
import { suppressGlobalPipelinePrompt } from '../../../navigation/pipelinePromptSuppression';
import { PipelineForeground } from '../../../native/PipelineForegroundModule';
import { requestNotificationPermission } from '../../../utils/notificationPermission';
import { usePipelineTaskStore } from '../../../store/pipelineTaskStore';
import { useProjectStore } from '../../../store/projectStore';
import {
  cancelContinuationRun,
  startContinuationRun,
} from '../../../services/continuation/generation';
import { getContinuationChapterNumbering } from '../../../services/continuation/chapterNumbering/continuationChapterNumbering';
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
  'idle' | 'queued' | 'drafting' | 'reviewing' | 'factChecking' | 'proofing'
>;
type CreateTask = (
  targetType: 'chapter' | 'freeform',
  targetId: number,
) => string;

const RUNNING_PIPELINE_STATUSES: RunningPipelineStatus[] = [
  'idle',
  'queued',
  'drafting',
  'reviewing',
  'factChecking',
  'proofing',
];

function stageFromTaskStatus(
  status: RunningPipelineStatus,
): PipelineStageName | 'idle' {
  if (status === 'drafting') return 'draft';
  if (status === 'reviewing') return 'review';
  if (status === 'factChecking') return 'factCheck';
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
  const [continuationStage, setContinuationStage] =
    useState<ContinuationPipelineStage | null>(null);
  const resultTaskIdRef = useRef<string | null>(null);
  const seenTerminalRef = useRef<Set<string>>(new Set());
  const continuationStageRef = useRef<ContinuationPipelineStage | null>(null);

  const openPipelineResult = useCallback(
    (taskId: string) => {
      if (taskId === resultTaskIdRef.current) return;
      resultTaskIdRef.current = taskId;
      setProgressVisible(false);
      setGenerating(false);
      setQueued(false);
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
      if (
        task.id === resultTaskIdRef.current ||
        seenTerminalRef.current.has(task.id)
      )
        return;
      seenTerminalRef.current.add(task.id);
      if (task.status === 'completed') {
        openPipelineResult(task.id);
      } else if (task.status === 'failed') {
        resultTaskIdRef.current = task.id;
        setProgressVisible(false);
        setGenerating(false);
        setQueued(false);
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

  const executeRunPipeline = useCallback(
    async (createTask: CreateTask) => {
      if (!chapter) return;
      setGenerating(true);
      setProgressVisible(true);
      const taskId = createTask('chapter', chapter.id);
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
        await runChapterPipeline(
          taskId,
          chapter,
          (info: StageInfo | string) => {
            if (typeof info === 'object') {
              setCurrentStage(info.stage);
              setProgressStartedAt(info.startedAt);
            }
          },
        );
        setProgressVisible(false);
        setQueued(false);
        const finishedTask = usePipelineTaskStore
          .getState()
          .tasks.find(task => task.id === taskId);
        if (finishedTask?.status === 'completed') {
          openPipelineResult(taskId);
        } else if (finishedTask?.status === 'failed') {
          resultTaskIdRef.current = taskId;
          Alert.alert('流水线失败', finishedTask.error || '未知错误');
        }
      } catch (error: any) {
        setProgressVisible(false);
        setQueued(false);
        Alert.alert('流水线异常', error?.message || '请检查 API 配置。');
      } finally {
        setGenerating(false);
      }
    },
    [chapter, openPipelineResult],
  );

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
    setContinuationStage('context');
    continuationStageRef.current = 'context';
    try {
      await requestNotificationPermission();
      const numbering = await getContinuationChapterNumbering(project.id);
      const instruction =
        chapter.synopsis?.trim() ||
        `续写${numbering.getDefaultTitle(chapter.position as any)}，保持与前文一致。`;
      const run = await startContinuationRun({
        projectId: project.id,
        chapterId: chapter.id,
        targetPosition: chapter.position,
        userInstruction: instruction,
        currentChapterContent: chapter.content ?? '',
      });
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
          setContinuationStage(null);
          continuationStageRef.current = null;
          if (latest.state === 'failed') {
            Alert.alert('续写失败', latest.errorMessage || '未知错误');
          } else if (latest.state === 'cancelled') {
            Toast.show({ type: 'info', text1: '已取消续写' });
          } else {
            navigation.navigate('ContinuationResult', { runId: run.id });
          }
          return;
        }
        await new Promise(r => setTimeout(r, 800));
      }
      setProgressVisible(false);
      setGenerating(false);
      setContinuationStage(null);
      continuationStageRef.current = null;
    } catch (error: any) {
      setProgressVisible(false);
      setGenerating(false);
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
    const { createTask, getActiveTaskForTarget } =
      usePipelineTaskStore.getState();
    const existing = getActiveTaskForTarget('chapter', chapter.id);
    if (existing) {
      Alert.alert('已有进行中的流水线', '请等待当前任务完成或到任务中心取消。');
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
            onPress: () => executeRunPipeline(createTask).catch(() => {}),
          },
        ],
      );
    } else {
      executeRunPipeline(createTask).catch(() => {});
    }
  }, [chapter, executeRunPipeline, runContinuation]);

  const stopPipeline = useCallback(() => {
    setGenerating(false);
    setProgressVisible(false);
    setQueued(false);
    setContinuationStage(null);
    continuationStageRef.current = null;
    if (continuationRunIdRef.current) {
      const rid = continuationRunIdRef.current;
      cancelContinuationRun(rid).catch(() => {});
      continuationRunIdRef.current = null;
      PipelineForeground.stop(rid).catch(() => {});
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
    if (runningTask) cancelPipeline(runningTask.id);
  }, [chapterId]);

  return {
    currentStage,
    generating,
    progressStartedAt,
    progressVisible,
    queued,
    continuationStage,
    runPipeline,
    stopPipeline,
  };
}
