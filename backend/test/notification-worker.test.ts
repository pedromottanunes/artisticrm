import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { MessageChannel, type MessagePort } from 'node:worker_threads';

const source = readFileSync(new URL('../../frontend/public/sw.js', import.meta.url), 'utf8');
function harness(
  acknowledgement: 'handled' | 'unavailable' | 'timeout' | 'throw' | 'resumed' = 'handled',
) {
  const handlers = new Map<string, (event: any) => void>();
  const shown: any[] = [];
  const notices: any[] = [];
  const navigated: string[] = [];
  let skipWaitingCalls = 0;
  const windows = [false, true].map((focused, i) => ({
    url: 'https://crm.example.test/',
    visibilityState: 'visible',
    focused,
    postMessage: (data: unknown, ports: MessagePort[]) => {
      notices.push({ i, data });
      if (acknowledgement === 'throw') throw new Error('Client closed');
      if (acknowledgement === 'resumed')
        setTimeout(() => ports[0].postMessage({ handled: true }), 600);
      else if (acknowledgement !== 'timeout')
        ports[0].postMessage({ handled: acknowledgement === 'handled' });
    },
    navigate: async (url: string) => navigated.push(url),
    focus: async () => {},
  }));
  runInNewContext(source, {
    URL,
    encodeURIComponent,
    MessageChannel,
    setTimeout,
    clearTimeout,
    self: {
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
      location: { origin: 'https://crm.example.test' },
      registration: {
        showNotification: async (title: string, options: any) => shown.push({ title, ...options }),
      },
      skipWaiting: async () => {
        skipWaitingCalls += 1;
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => navigated.push(url),
      },
    },
    caches: {
      open: async () => ({ addAll: async () => {} }),
      keys: async () => [],
      delete: async () => true,
    },
  });
  const dispatch = async (name: string, value: Record<string, unknown>) => {
    let promise: Promise<unknown> | undefined;
    handlers.get(name)!({
      ...value,
      waitUntil: (pending: Promise<unknown>) => {
        promise = pending;
      },
    });
    await promise;
  };
  return {
    dispatch,
    shown,
    notices,
    navigated,
    windows,
    skipWaitingCalls: () => skipWaitingCalls,
  };
}
test('push worker: a nova versao assume o controle sem esperar o PWA ser fechado', async () => {
  const worker = harness();
  await worker.dispatch('install', {});
  assert.equal(worker.skipWaitingCalls(), 1);
});
test('push worker: checagem documental é silenciosa e abre Listas sem dados financeiros', async () => {
  const worker = harness();
  await worker.dispatch('push', {
    data: {
      json: () => ({ page: 'lists', tag: 'commercial-test', userId: 'user-a', silent: true }),
    },
  });
  assert.equal(worker.notices.length, 0, 'does not play the lead alarm');
  assert.equal(worker.shown[0].silent, true);
  assert.equal(worker.shown[0].data.page, 'lists');
  await worker.dispatch('notificationclick', {
    notification: { data: worker.shown[0].data, close: () => {} },
  });
  assert.deepEqual(worker.navigated, ['https://crm.example.test/#lists']);
});

test('push worker: waits briefly for resumed audio and preserves a single foreground sound', async () => {
  const worker = harness('resumed');
  const start = Date.now();
  await worker.dispatch('push', {
    data: { json: () => ({ page: 'mine', tag: 'resumed', userId: 'user-a' }) },
  });
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].silent, true);
  const deadline = worker.notices[0].data.soundDeadline;
  assert.ok(deadline >= start + 800 && deadline < start + 1000);
});
for (const response of ['unavailable', 'timeout', 'throw'] as const)
  test(`push worker: OS sound survives foreground ${response}`, async () => {
    const worker = harness(response);
    await worker.dispatch('push', {
      data: { json: () => ({ page: 'mine', tag: 'fallback', userId: 'user-a' }) },
    });
    assert.equal(worker.shown.length, 1);
    assert.equal(worker.shown[0].silent, false);
    assert.deepEqual(Array.from(worker.shown[0].vibrate), [200, 100, 200]);
  });
test('push worker: lead, pool and message use one custom foreground sound recipient', async () => {
  const worker = harness();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const data of [
    { page: 'mine', tag: 'new-lead', userId: 'user-a' },
    { page: 'pool', tag: 'new-pool-item', userId: 'user-a' },
    { page: 'inbox', opportunityId: id, tag: 'new-message', userId: 'user-a' },
  ])
    await worker.dispatch('push', {
      data: { json: () => data },
    });
  assert.equal(worker.shown.length, 3);
  assert.equal(new Set(worker.shown.map((notice) => notice.tag)).size, 3);
  assert.ok(worker.shown.every((notice) => notice.silent === true));
  assert.ok(worker.shown.every((notice) => notice.vibrate === undefined));
  assert.equal(worker.shown[0].renotify, false, 'a transport retry must not alert again');
  assert.deepEqual(
    worker.notices.map((item) => item.i),
    [1, 1, 1],
    'focused window only',
  );
  assert.equal(worker.notices[0].data.userId, 'user-a');
  await worker.dispatch('notificationclick', {
    notification: { close() {}, data: worker.shown[2].data },
  });
  assert.equal(worker.navigated[0], `https://crm.example.test/#inbox?lead=${id}`);
});
test('push worker: hidden windows stay silent; malformed content still shows a notification', async () => {
  const worker = harness();
  worker.windows.forEach((client) => {
    client.visibilityState = 'hidden';
  });
  await worker.dispatch('push', {
    data: {
      json: () => {
        throw new Error('bad payload');
      },
    },
  });
  assert.equal(worker.shown.length, 1);
  assert.equal(worker.shown[0].silent, false);
  assert.deepEqual(Array.from(worker.shown[0].vibrate), [200, 100, 200]);
  assert.equal(worker.notices.length, 0);
  await worker.dispatch('notificationclick', {
    notification: { close() {}, data: { page: 'inbox', opportunityId: 'https://evil.test' } },
  });
  assert.equal(worker.navigated[0], 'https://crm.example.test/#inbox');
});
