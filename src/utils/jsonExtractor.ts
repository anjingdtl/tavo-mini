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
  const stack: string[] = [];
  let start = -1;
  for (let i = 0; i < cleaned.length; i++) {
    if ((cleaned[i] === '{' || cleaned[i] === '[') && stack.length === 0) {
      start = i;
      stack.push(cleaned[i]);
    } else if (cleaned[i] === '{' || cleaned[i] === '[') {
      stack.push(cleaned[i]);
    } else if (cleaned[i] === '}' || cleaned[i] === ']') {
      const open = cleaned[i] === '}' ? '{' : '[';
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
