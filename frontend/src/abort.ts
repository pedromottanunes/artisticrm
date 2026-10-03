export interface TimedSignal {
  signal: AbortSignal;
  dispose: () => void;
}

// AbortSignal.any/timeout are unavailable in older WebKit versions used by
// iOS PWAs. Link a normal AbortController to the caller and a timer instead.
export function signalWithTimeout(parent: AbortSignal, milliseconds: number): TimedSignal {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (timer !== undefined) clearTimeout(timer);
    parent.removeEventListener('abort', abort);
  };
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    dispose();
  };
  parent.addEventListener('abort', abort, { once: true });
  timer = setTimeout(abort, milliseconds);
  if (parent.aborted) abort();
  return { signal: controller.signal, dispose };
}
