import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../../frontend/public/sw.js', import.meta.url), 'utf8');
function harness() {
  const handlers = new Map<string, (event: any) => void>();
  const shown: any[] = [];
  const notices: any[] = [];
  const navigated: string[] = [];
  const windows = [false, true].map((focused, i) => ({
    url: 'https://crm.example.test/',
    visibilityState: 'visible',
    focused,
    postMessage: (data: unknown) => notices.push({ i, data }),
    navigate: async (url: string) => navigated.push(url),
    focus: async () => {},
  }));
  runInNewContext(source, {
    URL,
    encodeURIComponent,
    self: {
      addEventListener: (name: string, handler: (event: any) => void) =>
        handlers.set(name, handler),
      location: { origin: 'https://crm.example.test' },
      registration: {
        showNotification: async (title: string, options: any) => shown.push({ title, ...options }),
      },
      clients: {
        matchAll: async () => windows,
        openWindow: async (url: string) => navigated.push(url),
      },
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
  return { dispatch, shown, notices, navigated, windows };
}
test('push worker: system alert, single visible sound recipient and exact chat deep link', async () => {
  const worker = harness();
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  for (const tag of ['message-1', 'message-2'])
    await worker.dispatch('push', {
      data: { json: () => ({ page: 'inbox', opportunityId: id, tag, userId: 'user-a' }) },
    });
  assert.equal(worker.shown.length, 2);
  assert.notEqual(worker.shown[0].tag, worker.shown[1].tag);
  assert.equal(worker.shown[0].silent, false);
  assert.equal(worker.shown[0].renotify, false, 'a transport retry must not alert again');
  assert.deepEqual(
    worker.notices.map((item) => item.i),
    [1, 1],
    'focused window only',
  );
  assert.equal(worker.notices[0].data.userId, 'user-a');
  await worker.dispatch('notificationclick', {
    notification: { close() {}, data: worker.shown[0].data },
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
  assert.equal(worker.notices.length, 0);
  await worker.dispatch('notificationclick', {
    notification: { close() {}, data: { page: 'inbox', opportunityId: 'https://evil.test' } },
  });
  assert.equal(worker.navigated[0], 'https://crm.example.test/#inbox');
});
