import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaProxy, trustedMediaUrl } from '../src/media-proxy.js';

const url = 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=test';
const limits = { total: 2, perUser: 1, bytes: 8, headersMs: 1000, idleMs: 1000, lifetimeMs: 2000 };
const bytes = (value = 'ok') => new Response(value);
const stalled = () =>
  new Response(
    new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => {});
      },
    }),
  );

test('media allowlist rejects credentials, ports, local addresses and lookalike domains', () => {
  for (const value of [
    'http://lookaside.fbsbx.com/a',
    'https://127.0.0.1',
    'https://fbcdn.net.evil.example/a',
    'https://evilfbcdn.net/a',
    'https://user:pass@fbcdn.net/a',
    'https://fbcdn.net:8080/a',
    'file:///etc/passwd',
  ])
    assert.equal(trustedMediaUrl(value), false, value);
  assert.equal(trustedMediaUrl(url), true);
  assert.equal(trustedMediaUrl('https://scontent.example.cdninstagram.com/image.jpg'), true);
});

test('proxy checks each redirect before requesting it and never forwards credentials', async () => {
  for (const destination of [
    'http://localhost/secret',
    'https://evil.example/a',
    'https://fbcdn.net:8443/a',
  ]) {
    let calls = 0;
    const proxy = new MediaProxy(async (_url, options) => {
      calls++;
      assert.equal(options?.redirect, 'manual');
      assert.equal(new Headers(options?.headers).get('authorization'), null);
      return new Response(null, { status: 302, headers: { location: destination } });
    });
    await assert.rejects(proxy.open('user', url), { code: 'MEDIA_UNAVAILABLE' });
    assert.equal(calls, 1);
  }
  let calls = 0;
  const proxy = new MediaProxy(async (_url, options) => {
    calls++;
    assert.equal(new Headers(options?.headers).get('range'), 'bytes=0-1');
    return calls === 1
      ? new Response(null, { status: 302, headers: { location: '/next' } })
      : bytes();
  });
  assert.equal(await new Response((await proxy.open('user', url, 'bytes=0-1')).body).text(), 'ok');
  assert.equal(calls, 2);
});

test('proxy caps redirect loops, ranges, declared size and actual streamed size', async () => {
  let calls = 0;
  const loop = new MediaProxy(async () => {
    calls++;
    return new Response(null, { status: 307, headers: { location: '/loop' } });
  });
  await assert.rejects(loop.open('user', url), { code: 'MEDIA_UNAVAILABLE' });
  assert.equal(calls, 6);
  await assert.rejects(loop.open('user', url, 'bytes=0-1,2-3'), { code: 'INVALID_RANGE' });
  const oversized = new MediaProxy(
    async () => new Response('large', { headers: { 'content-length': '100' } }),
    limits,
  );
  await assert.rejects(oversized.open('user', url), { code: 'MEDIA_TOO_LARGE' });
  const chunked = new MediaProxy(async () => bytes('123456789'), limits);
  const response = await chunked.open('user', url);
  await assert.rejects(new Response(response.body).text(), { code: 'MEDIA_TOO_LARGE' });
  // The failed request released its slot.
  await assert.rejects(new Response((await chunked.open('user', url)).body).text(), {
    code: 'MEDIA_TOO_LARGE',
  });
});

test('proxy releases concurrency slots on cancellation and limits active users globally', async () => {
  const proxy = new MediaProxy(async () => stalled(), limits);
  const first = await proxy.open('a', url);
  await assert.rejects(proxy.open('a', url), { code: 'MEDIA_BUSY' });
  const second = await proxy.open('b', url);
  await assert.rejects(proxy.open('c', url), { code: 'MEDIA_BUSY' });
  await first.body.cancel();
  await second.body.cancel();
  const third = await proxy.open('a', url);
  await third.body.cancel();
});

test('proxy aborts stalled response bodies and browser cancellations', async () => {
  const proxy = new MediaProxy(async () => stalled(), { ...limits, idleMs: 15 });
  await assert.rejects(new Response((await proxy.open('a', url)).body).text(), {
    code: 'MEDIA_UNAVAILABLE',
  });
  const abort = new AbortController();
  const response = await proxy.open('a', url, undefined, abort.signal);
  abort.abort();
  await assert.rejects(new Response(response.body).text(), { code: 'MEDIA_UNAVAILABLE' });
  const headers = new MediaProxy(
    async (_url, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
    { ...limits, headersMs: 15 },
  );
  await assert.rejects(headers.open('a', url), { code: 'MEDIA_UNAVAILABLE' });
});
