import { useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { signalWithTimeout } from './abort';

interface QueueStatus {
  participating: boolean;
  rank: number | null;
}

function label(status: QueueStatus) {
  if (!status.participating || status.rank === null) return 'Você está fora da fila';
  return status.rank === 1 ? 'Você é a próxima da fila' : `Você é a ${status.rank}ª da fila`;
}

export function QueuePosition({
  onSessionExpired,
}: {
  onSessionExpired: () => void | Promise<void>;
}) {
  const [status, setStatus] = useState<QueueStatus | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    let sequence = 0;
    let controller: AbortController | undefined;
    const load = async () => {
      if (disposed || document.hidden) return;
      window.clearTimeout(timer);
      const current = ++sequence;
      controller?.abort();
      controller = new AbortController();
      const request = signalWithTimeout(controller.signal, 15_000);
      try {
        const result = await api<QueueStatus>('/queue/me', { signal: request.signal });
        if (!disposed && !request.signal.aborted) setStatus(result);
      } catch (error) {
        if (
          !disposed &&
          !request.signal.aborted &&
          error instanceof ApiError &&
          error.status === 401
        )
          void onSessionExpired();
      } finally {
        request.dispose();
        if (!disposed && current === sequence) timer = window.setTimeout(() => void load(), 10_000);
      }
    };
    const resume = () => {
      if (!document.hidden) void load();
    };
    void load();
    window.addEventListener('focus', resume);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => {
      disposed = true;
      sequence += 1;
      controller?.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, [onSessionExpired]);

  if (!status) return null;
  return (
    <span
      className={`consultant-queue-position${status.participating ? '' : ' paused'}`}
      role="status"
      aria-label={label(status)}
    >
      <i />
      {label(status)}
    </span>
  );
}
