/**
 * Fail-closed errors for Phase-2 resource awareness / preset binding.
 * Structured codes only — never classify by Chinese message text.
 */

export type ResourceContextErrorCode =
  | 'RESOURCE_AWARENESS_READ_FAILED'
  | 'RESOURCE_AWARENESS_COMPILE_FAILED'
  | 'RESOURCE_AWARENESS_OVER_BUDGET'
  | 'PRESET_SOURCE_READ_FAILED'
  | 'RESOURCE_SOURCE_CHANGED_DURING_BUILD';

export type ResourceContextUserAction =
  | 'open_resources'
  | 'open_llm_settings'
  | 'restart_task'
  | 'none';

export class ResourceContextError extends Error {
  readonly code: ResourceContextErrorCode;
  readonly userAction: ResourceContextUserAction;
  readonly diagnostics?: Record<string, unknown>;

  constructor(
    code: ResourceContextErrorCode,
    message: string,
    userAction: ResourceContextUserAction = 'none',
    diagnostics?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ResourceContextError';
    this.code = code;
    this.userAction = userAction;
    this.diagnostics = diagnostics;
  }
}

export const RESOURCE_AWARENESS_OVER_BUDGET_MESSAGE =
  '当前启用资料的全局一致性约束超过此模型可安全承载范围。\n\n' +
  '可选处理：\n' +
  '1. 使用更大上下文模型；\n' +
  '2. 禁用当前项目不需要的资料；\n' +
  '3. 重建/压缩资料全局骨架；\n' +
  '4. 检查超长 legacy 资料是否尚未生成 Capsule。';
