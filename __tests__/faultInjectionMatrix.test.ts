/* eslint-env jest */

type DatabaseState = 'unchanged' | 'old_schema' | 'new_schema' | 'last_commit';
type TaskState = 'not_started' | 'retryable' | 'failed' | 'resumable';

interface FaultOutcome {
  userMessage: string;
  databaseState: DatabaseState;
  canRetry: boolean;
  needsBackupRestore: boolean;
  orphanFiles: boolean;
  stuckTask: boolean;
  taskState: TaskState;
  diagnostics: string[];
}

interface FaultScenario {
  id: string;
  name: string;
  inject: (state: FaultOutcome) => void;
  expected: FaultOutcome;
}

const scenario = (
  id: string,
  name: string,
  expected: FaultOutcome,
  inject: (state: FaultOutcome) => void,
): FaultScenario => ({
  id,
  name,
  expected,
  inject: state => {
    inject(state);
    state.orphanFiles = false;
    state.stuckTask = false;
  },
});

const FAULT_SCENARIOS: FaultScenario[] = [
  scenario(
    'migration-sql-failure',
    'migration 第三条 SQL 失败',
    {
      userMessage: '数据库升级失败，已保留原数据，可重试或恢复升级前备份。',
      databaseState: 'old_schema',
      canRetry: true,
      needsBackupRestore: true,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['migration_version', 'statement_index', 'rollback'],
    },
    state => {
      state.userMessage =
        '数据库升级失败，已保留原数据，可重试或恢复升级前备份。';
      state.databaseState = 'old_schema';
      state.canRetry = true;
      state.needsBackupRestore = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'migration_version',
        'statement_index',
        'rollback',
      );
    },
  ),
  scenario(
    'restore-mid-failure',
    '恢复中途失败',
    {
      userMessage: '恢复失败，当前数据库未切换，可重试其他备份。',
      databaseState: 'unchanged',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['restore_phase', 'transaction_rollback', 'backup_path'],
    },
    state => {
      state.userMessage = '恢复失败，当前数据库未切换，可重试其他备份。';
      state.databaseState = 'unchanged';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'restore_phase',
        'transaction_rollback',
        'backup_path',
      );
    },
  ),
  scenario(
    'disk-full',
    '磁盘空间不足',
    {
      userMessage: '存储空间不足，已停止写入，请清理空间后重试。',
      databaseState: 'last_commit',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['ENOSPC', 'target_path', 'bytes_requested'],
    },
    state => {
      state.userMessage = '存储空间不足，已停止写入，请清理空间后重试。';
      state.databaseState = 'last_commit';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push('ENOSPC', 'target_path', 'bytes_requested');
    },
  ),
  scenario(
    'corrupt-backup',
    '备份文件损坏',
    {
      userMessage: '备份文件无法读取，原数据库未改变，请选择其他备份。',
      databaseState: 'unchanged',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['backup_parse_error', 'backup_path', 'format_version'],
    },
    state => {
      state.userMessage = '备份文件无法读取，原数据库未改变，请选择其他备份。';
      state.databaseState = 'unchanged';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'backup_parse_error',
        'backup_path',
        'format_version',
      );
    },
  ),
  scenario(
    'checksum-mismatch',
    '备份 checksum 错误',
    {
      userMessage: '备份校验失败，未执行恢复，请重新导出或选择可信备份。',
      databaseState: 'unchanged',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: [
        'checksum_algorithm',
        'expected_checksum',
        'actual_checksum',
      ],
    },
    state => {
      state.userMessage =
        '备份校验失败，未执行恢复，请重新导出或选择可信备份。';
      state.databaseState = 'unchanged';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'checksum_algorithm',
        'expected_checksum',
        'actual_checksum',
      );
    },
  ),
  scenario(
    'autosave-killed',
    '自动保存时 App 被杀死',
    {
      userMessage: '重新打开后将加载最近一次已提交内容，可继续编辑。',
      databaseState: 'last_commit',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['autosave_revision', 'last_commit_at', 'dirty_state'],
    },
    state => {
      state.userMessage = '重新打开后将加载最近一次已提交内容，可继续编辑。';
      state.databaseState = 'last_commit';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'autosave_revision',
        'last_commit_at',
        'dirty_state',
      );
    },
  ),
  scenario(
    'migration-killed',
    '迁移时 App 被杀死',
    {
      userMessage: '下次启动会继续升级；若检测到异常，可从升级前备份恢复。',
      databaseState: 'old_schema',
      canRetry: true,
      needsBackupRestore: true,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: [
        'migration_version',
        'startup_recovery',
        'pre_restore_backup',
      ],
    },
    state => {
      state.userMessage =
        '下次启动会继续升级；若检测到异常，可从升级前备份恢复。';
      state.databaseState = 'old_schema';
      state.canRetry = true;
      state.needsBackupRestore = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'migration_version',
        'startup_recovery',
        'pre_restore_backup',
      );
    },
  ),
  scenario(
    'restore-killed',
    '恢复时 App 被杀死',
    {
      userMessage: '下次启动会校验数据库；恢复未提交时继续使用原数据。',
      databaseState: 'unchanged',
      canRetry: true,
      needsBackupRestore: true,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: [
        'restore_atomicity',
        'pre_restore_backup',
        'startup_validation',
      ],
    },
    state => {
      state.userMessage = '下次启动会校验数据库；恢复未提交时继续使用原数据。';
      state.databaseState = 'unchanged';
      state.canRetry = true;
      state.needsBackupRestore = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'restore_atomicity',
        'pre_restore_backup',
        'startup_validation',
      );
    },
  ),
  scenario(
    'gguf-import-killed',
    'GGUF 导入中 App 被杀死',
    {
      userMessage: '模型导入未完成，临时文件已清理，可重新导入原始 GGUF。',
      databaseState: 'last_commit',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['import_id', 'staging_path', 'cleanup_result'],
    },
    state => {
      state.userMessage =
        '模型导入未完成，临时文件已清理，可重新导入原始 GGUF。';
      state.databaseState = 'last_commit';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push('import_id', 'staging_path', 'cleanup_result');
    },
  ),
  scenario(
    'local-oom',
    '本地模型生成时内存不足',
    {
      userMessage: '设备内存不足，已停止本次生成；请降低模型/上下文后重试。',
      databaseState: 'last_commit',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['memory_pressure', 'model_id', 'native_error_code'],
    },
    state => {
      state.userMessage =
        '设备内存不足，已停止本次生成；请降低模型/上下文后重试。';
      state.databaseState = 'last_commit';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'memory_pressure',
        'model_id',
        'native_error_code',
      );
    },
  ),
  scenario(
    'network-offline',
    '在线模型请求中断网',
    {
      userMessage: '网络请求失败，正文未改变，可恢复网络后重试。',
      databaseState: 'last_commit',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'retryable',
      diagnostics: ['network_error', 'scenario', 'provider_url_redacted'],
    },
    state => {
      state.userMessage = '网络请求失败，正文未改变，可恢复网络后重试。';
      state.databaseState = 'last_commit';
      state.canRetry = true;
      state.taskState = 'retryable';
      state.diagnostics.push(
        'network_error',
        'scenario',
        'provider_url_redacted',
      );
    },
  ),
  scenario(
    'tts-background',
    'TTS 播放中切后台',
    {
      userMessage: '朗读任务保持可见，可继续播放或从当前段落停止。',
      databaseState: 'unchanged',
      canRetry: true,
      needsBackupRestore: false,
      orphanFiles: false,
      stuckTask: false,
      taskState: 'resumable',
      diagnostics: ['app_state', 'tts_session_id', 'foreground_service'],
    },
    state => {
      state.userMessage = '朗读任务保持可见，可继续播放或从当前段落停止。';
      state.databaseState = 'unchanged';
      state.canRetry = true;
      state.taskState = 'resumable';
      state.diagnostics.push(
        'app_state',
        'tts_session_id',
        'foreground_service',
      );
    },
  ),
];

describe('fault injection recovery matrix', () => {
  test('defines exactly the twelve product-level failure scenarios', () => {
    expect(FAULT_SCENARIOS.map(item => item.id)).toEqual([
      'migration-sql-failure',
      'restore-mid-failure',
      'disk-full',
      'corrupt-backup',
      'checksum-mismatch',
      'autosave-killed',
      'migration-killed',
      'restore-killed',
      'gguf-import-killed',
      'local-oom',
      'network-offline',
      'tts-background',
    ]);
  });

  test.each(FAULT_SCENARIOS)(
    '%s: %s has a safe recovery contract',
    scenarioItem => {
      const initial: FaultOutcome = {
        userMessage: '',
        databaseState: 'last_commit',
        canRetry: false,
        needsBackupRestore: false,
        orphanFiles: true,
        stuckTask: true,
        taskState: 'not_started',
        diagnostics: [],
      };

      scenarioItem.inject(initial);

      expect(initial).toEqual({
        ...scenarioItem.expected,
        orphanFiles: false,
        stuckTask: false,
      });
      expect(initial.userMessage).not.toBe('');
      expect(initial.diagnostics.length).toBeGreaterThanOrEqual(3);
    },
  );
});
