import { DomainError } from './types.js';

const hosts = ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com', 'instagram.com'];
export function trustedMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
    );
  } catch {
    return false;
  }
}

const unavailable = () =>
  new DomainError(
    'MEDIA_UNAVAILABLE',
    'Mídia indisponível. Não foi possível carregar a mídia.',
    502,
  );
const tooLarge = () =>
  new DomainError('MEDIA_TOO_LARGE', 'A mídia excede o limite permitido.', 413);

// Streaming with backpressure: no binary data is buffered in memory or persisted.
// Only the fallback goes through here; direct browser/CDN playback is unchanged.
export class MediaProxy {
  private active = 0;
  private users = new Map<string, number>();
  constructor(
    private request: typeof fetch = fetch,
    private limits = {
      total: 24,
      perUser: 8,
      bytes: 128 * 1024 * 1024,
      headersMs: 20_000,
      idleMs: 30_000,
      lifetimeMs: 15 * 60_000,
    },
  ) {}

  async open(
    userId: string,
    url: string,
    range?: string,
    signal?: AbortSignal,
    maxBytes = this.limits.bytes,
  ) {
    if (!trustedMediaUrl(url)) throw unavailable();
    if (range && (!/^bytes=(?:\d+-\d*|-\d+)$/.test(range) || range.length > 80))
      throw new DomainError('INVALID_RANGE', 'Intervalo de mídia inválido.', 416);
    const count = this.users.get(userId) ?? 0;
    if (this.active >= this.limits.total || count >= this.limits.perUser)
      throw new DomainError(
        'MEDIA_BUSY',
        'Aguarde as outras mídias carregarem e tente novamente.',
        429,
      );
    if (signal?.aborted) throw unavailable();
    this.active++;
    this.users.set(userId, count + 1);
    const abort = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let output: ReadableStreamDefaultController<Uint8Array> | undefined;
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(headersTimer);
      clearTimeout(lifetimeTimer);
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      this.active--;
      const remaining = (this.users.get(userId) ?? 1) - 1;
      if (remaining) this.users.set(userId, remaining);
      else this.users.delete(userId);
      if (error) output?.error(error);
      abort.abort();
      void reader?.cancel().catch(() => {});
    };
    const onAbort = () => finish(unavailable());
    const headersTimer = setTimeout(onAbort, this.limits.headersMs);
    const lifetimeTimer = setTimeout(onAbort, this.limits.lifetimeMs);
    lifetimeTimer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      let response: Response | undefined;
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (done) throw unavailable();
        response = await this.request(url, {
          method: 'GET',
          redirect: 'manual',
          signal: abort.signal,
          ...(range ? { headers: { Range: range } } : {}),
        });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          await response.body?.cancel().catch(() => {});
          if (!location || redirects === 5) throw unavailable();
          const next = new URL(location, url).href;
          if (!trustedMediaUrl(next)) throw unavailable();
          url = next;
          continue;
        }
        break;
      }
      clearTimeout(headersTimer);
      if (
        done ||
        !response?.ok ||
        !response.body ||
        (response.url && !trustedMediaUrl(response.url))
      ) {
        await response?.body?.cancel().catch(() => {});
        throw unavailable();
      }
      const length = response.headers.get('content-length');
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        await response.body.cancel().catch(() => {});
        throw tooLarge();
      }
      reader = response.body.getReader();
      let received = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          output = controller;
        },
        pull: async (controller) => {
          if (done) return;
          idle = setTimeout(onAbort, this.limits.idleMs);
          try {
            const chunk = await reader!.read();
            clearTimeout(idle);
            if (done) return;
            if (chunk.done) {
              controller.close();
              finish();
              return;
            }
            received += chunk.value.byteLength;
            if (received > maxBytes) {
              finish(tooLarge());
              return;
            }
            controller.enqueue(chunk.value);
          } catch {
            finish(unavailable());
          }
        },
        cancel() {
          finish();
        },
      });
      return { body, status: response.status, headers: response.headers };
    } catch (error) {
      finish();
      throw error instanceof DomainError ? error : unavailable();
    }
  }
}
