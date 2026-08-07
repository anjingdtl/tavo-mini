/**
 * CL-04: real startup phases + progress weights.
 *
 * The App init sequence reports each REAL awaited step through
 * `reportStartupProgress`; the UI renders the phase label and percent. No
 * random timers — percent only moves when an actual step starts/completes.
 */

export type StartupPhase =
  | 'opening_database'
  | 'checking_schema'
  | 'capturing_fingerprint'
  | 'creating_backup'
  | 'migrating'
  | 'validating_schema'
  | 'verifying_content'
  | 'loading_settings'
  | 'recovering_tasks'
  | 'ready'
  | 'failed';

export interface StartupProgress {
  phase: StartupPhase;
  /** 0-100, driven by real step boundaries. */
  percent: number;
  message: string;
  detail?: string;
}

/** Phase → percent range (plan §7 weight table). */
export const STARTUP_PHASE_RANGES: Record<StartupPhase, [number, number]> = {
  opening_database: [0, 10],
  checking_schema: [10, 20],
  capturing_fingerprint: [20, 30],
  creating_backup: [30, 50],
  migrating: [50, 70],
  validating_schema: [70, 80],
  verifying_content: [80, 92],
  loading_settings: [92, 95],
  recovering_tasks: [95, 98],
  ready: [100, 100],
  failed: [100, 100],
};

export const STARTUP_PHASE_MESSAGES: Record<StartupPhase, string> = {
  opening_database: '正在打开本地数据库…',
  checking_schema: '正在检查数据结构…',
  capturing_fingerprint: '正在生成内容指纹…',
  creating_backup: '正在创建安全备份…',
  migrating: '正在升级数据库（请勿关闭应用）…',
  validating_schema: '正在校验数据库结构…',
  verifying_content: '正在核验资料内容…',
  loading_settings: '正在载入设置…',
  recovering_tasks: '正在恢复任务状态…',
  ready: '已就绪',
  failed: '载入失败',
};

/** Phase entry point → progress percent (range start). */
export function phaseStartPercent(phase: StartupPhase): number {
  return STARTUP_PHASE_RANGES[phase][0];
}

export function phaseEndPercent(phase: StartupPhase): number {
  return STARTUP_PHASE_RANGES[phase][1];
}

export function progressFor(phase: StartupPhase): StartupProgress {
  return {
    phase,
    percent: phaseEndPercent(phase),
    message: STARTUP_PHASE_MESSAGES[phase],
  };
}
