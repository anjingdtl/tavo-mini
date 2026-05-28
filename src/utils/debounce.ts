export function debounce<T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
): { call: T; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    call: ((...args: Parameters<T>) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    }) as T,
    cancel: () => {
      if (timer) clearTimeout(timer);
    },
  };
}
