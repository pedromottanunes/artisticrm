import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

// Exercise the real client effects with controlled network/worker failures and
// timers, without asking for notification permission or sending a real push.
const source = ts.transpileModule(
  readFileSync(new URL('../../frontend/src/pwa.tsx', import.meta.url), 'utf8') +
    '\nexports.checkDevicePush = checkDevicePush; exports.setOptedOut = setOptedOut; exports.disconnectPush = disconnectPush;',
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  },
).outputText;

function harness() {
  const effects: Array<() => () => void> = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const statuses: any[] = [];
  const storage = new Map<string, string>();
  let timerId = 0;
  let apiFails = false;
  let workerFails = false;
  let permission = 'granted';
  let audible = true;
  let playable = false;
  let plays = 0;
  let bindings = 0;
  let storageFails = false;
  let unsubscribeResult = true;
  let unsubscribes = 0;
  const window = Object.assign(new EventTarget(), {
    isSecureContext: true,
    Notification: {},
    PushManager: {},
    setInterval: () => 0,
    clearInterval: () => {},
  });
  const worker = Object.assign(new EventTarget(), {
    register: async () => {
      if (workerFails) throw new Error('Worker unavailable');
      return registration;
    },
    getRegistration: async () => registration,
  });
  const publicKey = Buffer.from([4, ...Array(64).fill(1)]).toString('base64url');
  const registration = {
    active: {},
    pushManager: {
      getSubscription: async () => ({
        endpoint: 'mock',
        options: { applicationServerKey: new Uint8Array([4, ...Array(64).fill(1)]).buffer },
        toJSON: () => ({ endpoint: 'mock' }),
        unsubscribe: async () => {
          unsubscribes++;
          return unsubscribeResult;
        },
      }),
    },
  };
  Object.defineProperty(worker, 'ready', { get: () => Promise.resolve(registration) });
  window.addEventListener('artisti-push-status', (event: any) => statuses.push(event.detail));
  const exports: any = {};
  runInNewContext(source, {
    exports,
    window,
    navigator: { serviceWorker: worker },
    document: Object.assign(new EventTarget(), { hidden: false }),
    Notification: {
      get permission() {
        return permission;
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (storageFails) throw new Error('Storage unavailable');
        storage.set(key, value);
      },
      removeItem: (key: string) => {
        if (storageFails) throw new Error('Storage unavailable');
        storage.delete(key);
      },
    },
    CustomEvent,
    Event,
    AbortSignal,
    Date,
    Uint8Array,
    btoa,
    atob,
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++timerId, { fn, ms });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
    require: (name: string) =>
      name === 'react'
        ? { useEffect: (fn: () => () => void) => effects.push(fn) }
        : name === './api'
          ? {
              api: async (path: string) => {
                if (apiFails) throw new Error('Network unavailable');
                if (path === '/push/subscriptions') bindings++;
                return { enabled: true, publicKey };
              },
            }
          : name === './notification-sound'
            ? {
                soundEnabled: () => audible,
                playNotificationSound: () => {
                  plays++;
                  return playable;
                },
              }
            : {},
  });
  exports.PushBinding({ userId: 'consultant' });
  const flush = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  return {
    statuses,
    timers,
    flush,
    bindings: () => bindings,
    plays: () => plays,
    start: () => {
      const cleanup = effects.map((effect) => effect());
      return () => cleanup.forEach((fn) => fn());
    },
    check: (userId = 'consultant') => exports.checkDevicePush(userId),
    optOut: (value: boolean, userId = 'consultant') => exports.setOptedOut(userId, value),
    failStorage: (value: boolean) => {
      storageFails = value;
    },
    disconnect: () => exports.disconnectPush(),
    unsubscribes: () => unsubscribes,
    unsubscribeResult: (value: boolean) => {
      unsubscribeResult = value;
    },
    failApi: (value: boolean) => {
      apiFails = value;
    },
    failWorker: (value: boolean) => {
      workerFails = value;
    },
    permission: (value: string) => {
      permission = value;
    },
    sound: (enabled: boolean, ready: boolean) => {
      audible = enabled;
      playable = ready;
    },
    receive: (tag: string, userId = 'consultant', deadline = Date.now() + 500) => {
      const responses: any[] = [];
      const event = new Event('message');
      Object.assign(event, {
        data: { type: 'artisti-push', tag, userId, soundDeadline: deadline },
        ports: [{ postMessage: (value: unknown) => responses.push(value) }],
      });
      worker.dispatchEvent(event);
      return responses[0]?.handled;
    },
    retry: async (delay = 15_000) => {
      const entry = [...timers].find(([, timer]) => timer.ms === delay);
      assert.ok(entry, 'a short retry must be scheduled');
      timers.delete(entry[0]);
      entry[1].fn();
      await flush();
    },
  };
}

test('push client: worker registration failure retries and binds without another browser event', async () => {
  const client = harness();
  client.failWorker(true);
  const stop = client.start();
  await client.flush();
  assert.ok(client.statuses.at(-1).error);
  assert.equal(client.bindings(), 0);
  client.failWorker(false);
  await client.retry();
  assert.equal(client.statuses.at(-1).subscribed, true);
  assert.equal(client.bindings(), 1);
  assert.equal(client.timers.size, 0);
  stop();
});

test('push client: storage write failure preserves manual opt-out during automatic checks', async () => {
  const client = harness();
  const stop = client.start();
  await client.flush();
  const before = client.bindings();
  client.failStorage(true);
  client.optOut(true);
  await client.check();
  assert.equal(client.statuses.at(-1).subscribed, false);
  assert.equal(client.bindings(), before);
  await client.check('another-user');
  assert.equal(client.statuses.at(-1).subscribed, true, 'opt-out is scoped to each user');
  stop();
});

test('push client: storage removal failure still allows an explicit reactivation', async () => {
  const client = harness();
  client.optOut(true);
  await client.check();
  assert.equal(client.bindings(), 0);
  client.failStorage(true);
  client.optOut(false);
  await client.check();
  assert.equal(client.statuses.at(-1).subscribed, true);
  assert.equal(client.bindings(), 1);
  // Once storage recovers, a new choice can be saved normally again.
  client.failStorage(false);
  client.optOut(true);
  await client.check();
  assert.equal(client.statuses.at(-1).subscribed, false);
  assert.equal(client.bindings(), 1);
});

test('push client: simultaneous checks share one request and denied permission never binds', async () => {
  const client = harness();
  const first = client.check();
  assert.equal(client.check(), first);
  await first;
  assert.equal(client.bindings(), 1);
  client.permission('denied');
  await client.check();
  assert.equal(client.statuses.at(-1).subscribed, false);
  assert.equal(client.bindings(), 1);
});

for (const serverWorks of [true, false])
  for (const browserWorks of [true, false])
    test(`push client: disable attempts both sides (server=${serverWorks}, browser=${browserWorks})`, async () => {
      const client = harness();
      client.failApi(!serverWorks);
      client.unsubscribeResult(browserWorks);
      if (serverWorks || browserWorks) await assert.doesNotReject(client.disconnect());
      else await assert.rejects(client.disconnect());
      assert.equal(client.unsubscribes(), 1);
    });

test('push client: retries back off to one minute and reset after recovery', async () => {
  const client = harness();
  client.failApi(true);
  const stop = client.start();
  await client.flush();
  for (const delay of [15_000, 30_000, 60_000]) await client.retry(delay);
  assert.equal(client.timers.size, 1);
  assert.ok(client.statuses.at(-1).error);
  client.failApi(false);
  await client.retry(60_000);
  assert.equal(client.statuses.at(-1).subscribed, true);
  assert.equal(client.timers.size, 0);
  client.failApi(true);
  await client.check();
  assert.equal([...client.timers.values()][0].ms, 15_000);
  stop();
});

test('push client: a panel-only failure schedules recovery; unmount cancels retry', async () => {
  const client = harness();
  const stop = client.start();
  await client.flush();
  client.failApi(true);
  await client.check();
  assert.ok(client.statuses.at(-1).error);
  client.failApi(false);
  await client.retry();
  assert.equal(client.statuses.at(-1).subscribed, true);
  client.failApi(true);
  await client.check();
  assert.equal(client.timers.size, 1);
  stop();
  assert.equal(client.timers.size, 0);
});

test('push client: sound acknowledgement respects unavailable audio, mute, duplicates and recipient', async () => {
  const client = harness();
  client.permission('default');
  const stop = client.start();
  await client.flush();
  assert.equal(client.receive('no-audio'), false);
  client.sound(true, true);
  assert.equal(client.receive('audible'), true);
  const played = client.plays();
  assert.equal(client.receive('audible'), true);
  assert.equal(client.plays(), played);
  assert.equal(client.receive('wrong-user', 'someone-else'), false);
  assert.equal(client.receive('late', 'consultant', Date.now() - 1), false);
  client.sound(false, false);
  assert.equal(client.receive('muted'), true);
  assert.equal(client.plays(), played);
  stop();
});
