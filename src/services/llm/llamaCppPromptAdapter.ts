import type { ChatMessage } from './types';
import type { PromptTemplate } from '../../types/localModel';

/**
 * llama.cpp 本地模型 Prompt 模板适配器。
 *
 * 不同模型族使用不同的 chat 格式化模板。生成时把 ChatMessage[]
 * 拼成单个 prompt 字符串传给原生层（原生层不再做 chat 格式化）。
 *
 * 支持的模板：
 *  - chatml: Qwen2/2.5、GLM-4、Yi、DeepSeek 等（最通用）
 *  - qwen:   Qwen2/2.5 官方即 chatml，与 chatml 同构
 *  - llama3: Llama-3 / Llama-3.1
 *  - alpaca: Alpaca / 早期 instruction 模型
 *  - phi:    Phi-3 mini
 *  - mistral: Mistral / Mixtral（system 塞进首个 [INST]）
 *  - custom: 简单 role: content 拼接（兜底）
 */

export const PROMPT_TEMPLATES: { value: PromptTemplate; label: string; hint: string }[] = [
  { value: 'chatml', label: 'ChatML', hint: 'Qwen2/2.5、GLM-4、Yi、DeepSeek' },
  { value: 'qwen', label: 'Qwen (ChatML)', hint: 'Qwen2/2.5 官方格式' },
  { value: 'llama3', label: 'Llama-3', hint: 'Llama-3 / Llama-3.1' },
  { value: 'alpaca', label: 'Alpaca', hint: 'Alpaca / 早期指令模型' },
  { value: 'phi', label: 'Phi-3', hint: 'Phi-3 mini' },
  { value: 'mistral', label: 'Mistral', hint: 'Mistral / Mixtral' },
  { value: 'custom', label: '自定义', hint: '简单 role: content 拼接兜底' },
];

function splitSystem(messages: ChatMessage[]): { system: string; dialog: ChatMessage[] } {
  const systemMsg = messages.find((m) => m.role === 'system');
  const system = systemMsg?.content?.trim() || '';
  const dialog = messages.filter((m) => m.role !== 'system');
  return { system, dialog };
}

function formatChatml(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = [];
  if (system) parts.push(`<|im_start|>system\n${system}<|im_end|>`);
  for (const m of dialog) {
    parts.push(`<|im_start|>${m.role}\n${m.content}<|im_end|>`);
  }
  parts.push(`<|im_start|>assistant\n`);
  return parts.join('\n');
}

function formatLlama3(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = ['<|begin_of_text|>'];
  if (system) {
    parts.push(`<|start_header_id|>system<|end_header_id|>\n\n${system}<|eot_id|>`);
  }
  for (const m of dialog) {
    parts.push(`<|start_header_id|>${m.role}<|end_header_id|>\n\n${m.content}<|eot_id|>`);
  }
  parts.push(`<|start_header_id|>assistant<|end_header_id|>\n\n`);
  return parts.join('');
}

function formatAlpaca(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = [];
  if (system) parts.push(system);
  for (const m of dialog) {
    if (m.role === 'user') {
      parts.push(`### Instruction:\n${m.content}`);
    } else {
      parts.push(`### Response:\n${m.content}`);
    }
  }
  parts.push(`### Response:\n`);
  return parts.join('\n\n');
}

function formatPhi(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = [];
  if (system) parts.push(`<|system|>\n${system}<|end|>`);
  for (const m of dialog) {
    parts.push(`<|${m.role}|>\n${m.content}<|end|>`);
  }
  parts.push(`<|assistant|>\n`);
  return parts.join('\n');
}

function formatMistral(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = [];
  let firstUser = true;
  for (const m of dialog) {
    if (m.role === 'user') {
      const inner = firstUser && system ? `${system}\n\n${m.content}` : m.content;
      parts.push(`[INST] ${inner} [/INST]`);
      firstUser = false;
    } else {
      // assistant 历史：原样追加并以 </s> 结束
      parts.push(` ${m.content}</s>`);
    }
  }
  return parts.join('');
}

function formatCustom(messages: ChatMessage[]): string {
  const { system, dialog } = splitSystem(messages);
  const parts: string[] = [];
  if (system) parts.push(`System: ${system}`);
  for (const m of dialog) {
    parts.push(`${m.role}: ${m.content}`);
  }
  parts.push(`assistant:`);
  return parts.join('\n');
}

export function applyPromptTemplate(template: PromptTemplate, messages: ChatMessage[]): string {
  switch (template) {
    case 'chatml':
      return formatChatml(messages);
    case 'qwen':
      // Qwen2/2.5 官方即 ChatML，复用同一实现
      return formatChatml(messages);
    case 'llama3':
      return formatLlama3(messages);
    case 'alpaca':
      return formatAlpaca(messages);
    case 'phi':
      return formatPhi(messages);
    case 'mistral':
      return formatMistral(messages);
    case 'custom':
      return formatCustom(messages);
    default:
      return formatChatml(messages);
  }
}
