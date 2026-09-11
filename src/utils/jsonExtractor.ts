function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thought[\s\S]*?<\/thought>/gi, '')
    .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '');
}

function stripCodeFence(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/i);
  return fenceMatch ? fenceMatch[1].trim() : text;
}

/**
 * 仅移除字符串外、紧邻 `}` / `]` 的尾逗号。
 * 与直接使用正则不同，这不会改写字符串值里恰好出现的 `,}` 或 `,]`。
 */
export function repairJSONTrailingCommas(text: string): string {
  let repaired = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      repaired += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      repaired += ch;
      continue;
    }
    if (ch === ',') {
      let next = i + 1;
      while (next < text.length && /\s/.test(text[next])) next += 1;
      if (text[next] === '}' || text[next] === ']') {
        continue;
      }
    }
    repaired += ch;
  }
  return repaired;
}

/**
 * 判断模型是否明显已经开始输出 JSON、但结构在末尾没有闭合。
 * 这只是错误分类辅助，不会尝试猜测或补全任何内容。
 */
export function looksLikeTruncatedJSON(text: string): boolean {
  const cleaned = stripCodeFence(stripReasoningBlocks(String(text || '')));
  const start = cleaned.search(/\{|\[/);
  if (start < 0) return false;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const open = ch === '}' ? '{' : '[';
      if (stack.length > 0 && stack[stack.length - 1] === open) {
        stack.pop();
      }
    }
  }
  return inString || stack.length > 0;
}

export function extractJSON(text: string): string | null {
  const cleaned = stripCodeFence(stripReasoningBlocks(String(text || '')));

  // Find first balanced JSON object or array. Track string literals so braces
  // inside a description do not terminate the candidate early.
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if ((ch === '{' || ch === '[') && stack.length === 0) {
      start = i;
      stack.push(ch);
    } else if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      const open = ch === '}' ? '{' : '[';
      if (stack.length > 0 && stack[stack.length - 1] === open) {
        stack.pop();
        if (stack.length === 0) {
          return cleaned.substring(start, i + 1);
        }
      }
    }
  }
  return null;
}
