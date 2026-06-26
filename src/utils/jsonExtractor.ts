export function extractJSON(text: string): string | null {
  let cleaned = text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/<thought[\s\S]*?<\/thought>/gi, '')
    .replace(/<reasoning[\s\S]*?<\/reasoning>/gi, '');

  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  // Find first balanced JSON object or array
  // 跟踪字符串字面量状态，避免字符串值内的括号被误判为结构括号
  const stack: string[] = [];
  let start = -1;
  let inString = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      // 处理字符串内的转义字符
      if (ch === '\\') {
        i += 1;
        continue;
      }
      // 遇到结束引号退出字符串
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    // 非字符串状态下：遇到引号进入字符串
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
