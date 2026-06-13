export interface DebouncedAsync<TArgs extends unknown[]> {
  call: (...args: TArgs) => void;
  flush: () => Promise<void>;
  cancel: () => void;
  pending: () => boolean;
}

export function debounce<TArgs extends unknown[]>(
  fn: (...args: TArgs) => void | Promise<void>,
  delay: number,
): DebouncedAsync<TArgs> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latestArgs: TArgs | null = null;
  let running: Promise<void> | null = null;

  const execute = async () => {
    if (!latestArgs) return;
    const args = latestArgs;
    latestArgs = null;
    if (timer) clearTimeout(timer);
    timer = null;
    running = Promise.resolve(fn(...args));
    try {
      await running;
    } finally {
      running = null;
    }
  };

  return {
    call: (...args) => {
      latestArgs = args;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { execute().catch(() => {}); }, delay);
    },
    flush: async () => {
      if (running) await running;
      if (latestArgs) await execute();
    },
    cancel: () => {
      if (timer) clearTimeout(timer);
      timer = null;
      latestArgs = null;
    },
    pending: () => latestArgs !== null || running !== null,
  };
}
