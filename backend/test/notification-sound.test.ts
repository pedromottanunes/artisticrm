import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.transpileModule(
  readFileSync(new URL('../../frontend/src/notification-sound.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness() {
  let now = 0;
  let timerId = 0;
  let mode: 'ready' | 'pending' | 'blocked' = 'ready';
  let storageFails = false;
  let failNode = false;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const contexts: TestAudio[] = [];
  const nodes: any[] = [];
  const gains: number[] = [];
  const states: boolean[] = [];
  const storage = new Map<string, string>();
  const pending: Array<() => void> = [];
  class TestAudio {
    state = 'suspended';
    onstatechange: (() => void) | null = null;
    destination = {};
    resumes = 0;
    constructor() {
      contexts.push(this);
    }
    get currentTime() {
      return now / 1000;
    }
    change(state: string) {
      this.state = state;
      this.onstatechange?.();
    }
    resume() {
      this.resumes++;
      if (mode === 'blocked') return Promise.reject(new Error('Gesture required'));
      if (mode === 'pending')
        return new Promise<void>((resolve) =>
          pending.push(() => {
            this.change('running');
            resolve();
          }),
        );
      this.change('running');
      return Promise.resolve();
    }
    createOscillator() {
      if (failNode && nodes.length === 2) throw new Error('Audio hardware unavailable');
      const node = {
        type: '',
        frequency: { value: 0 },
        onended: null as null | (() => void),
        startAt: -1,
        stops: [] as Array<number | undefined>,
        disconnected: false,
        connect() {},
        disconnect() {
          node.disconnected = true;
        },
        start(at: number) {
          node.startAt = at;
        },
        stop(at?: number) {
          node.stops.push(at);
        },
      };
      nodes.push(node);
      return node;
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: (value: number) => gains.push(value),
          linearRampToValueAtTime: (value: number) => gains.push(value),
        },
        connect() {},
        disconnect() {},
      };
    }
  }
  const window = Object.assign(new EventTarget(), { AudioContext: TestAudio });
  const document = { hidden: false };
  const exports: any = {};
  window.addEventListener('artisti-sound-state', () =>
    states.push(exports.notificationSoundReady()),
  );
  runInNewContext(source, {
    exports,
    window,
    document,
    Event,
    localStorage: {
      getItem: (key: string) => {
        if (storageFails) throw new Error('Storage denied');
        return storage.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (storageFails) throw new Error('Storage denied');
        storage.set(key, value);
      },
    },
    setTimeout: (fn: () => void, ms: number) => {
      timers.set(++timerId, { at: now + ms, fn });
      return timerId;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const flush = async () => {
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  return {
    api: exports,
    contexts,
    nodes,
    gains,
    states,
    document,
    timers,
    flush,
    mode: (next: typeof mode) => {
      mode = next;
    },
    failStorage: () => {
      storageFails = true;
    },
    failNode: () => {
      failNode = true;
    },
    resolve: () => pending.splice(0).forEach((resolve) => resolve()),
    advance: async (ms: number) => {
      now += ms;
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      await flush();
    },
  };
}

test('notification audio: bounded 2.64s alert preserves timbre and headroom without overlap', async () => {
  const sound = harness();
  assert.equal(await sound.api.prepareNotificationSound(), true);
  assert.equal(sound.api.playNotificationSound(), true);
  assert.equal(sound.nodes.length, 12);
  assert.deepEqual(
    sound.nodes.map((n) => n.frequency.value),
    Array.from({ length: 12 }, (_, i) => (i % 2 ? 660 : 880)),
  );
  assert.ok(sound.nodes.every((n) => n.type === 'square'));
  assert.ok(Math.abs(sound.nodes.at(-1).stops[0] - 2.64) < 0.00001);
  assert.equal(Math.max(...sound.gains), 0.45);
  assert.equal(sound.api.playNotificationSound(), true);
  assert.equal(
    sound.nodes.length,
    12,
    'a burst shares the current alert rather than stacking sound',
  );
  await sound.advance(2700);
  assert.equal(sound.api.playNotificationSound(), true);
  assert.equal(sound.nodes.length, 24);
  assert.ok(sound.nodes.slice(0, 12).every((n) => n.disconnected));
});

test('notification audio: interruption cancels old pulses; recovery prepares without replay', async () => {
  const sound = harness();
  await sound.api.prepareNotificationSound();
  sound.api.playNotificationSound();
  sound.contexts[0].change('interrupted');
  assert.equal(sound.api.notificationSoundReady(), false);
  assert.ok(sound.nodes.every((n) => n.disconnected && n.stops.at(-1) === undefined));
  assert.equal(sound.api.playNotificationSound(), false);
  assert.equal(await sound.api.prepareNotificationSound(), true);
  assert.equal(sound.nodes.length, 12, 'resume does not replay an expired notification');
  assert.deepEqual(sound.states, [false, true, false, true]);
  assert.equal(sound.api.playNotificationSound(), true);
  assert.equal(sound.nodes.length, 24);
});

test('notification audio: concurrent resume attempts are shared, bounded and never play late', async () => {
  const sound = harness();
  sound.mode('pending');
  const first = sound.api.prepareNotificationSound({ timeoutMs: 300 });
  const second = sound.api.prepareNotificationSound({ timeoutMs: 800 });
  assert.equal(sound.contexts[0].resumes, 1);
  await sound.advance(300);
  assert.equal(await first, false);
  await sound.advance(500);
  assert.equal(await second, false);
  assert.equal(sound.timers.size, 0);
  sound.resolve();
  await sound.flush();
  assert.equal(sound.api.notificationSoundReady(), true);
  assert.equal(sound.nodes.length, 0, 'late resume only changes readiness, never plays');
});

test('notification audio: stuck resume can retry on a later gesture', async () => {
  const sound = harness();
  sound.mode('pending');
  const first = sound.api.prepareNotificationSound();
  await sound.advance(800);
  assert.equal(await first, false);
  sound.mode('ready');
  assert.equal(await sound.api.prepareNotificationSound(), true);
  assert.equal(sound.contexts[0].resumes, 2);
});

test('notification audio: a real gesture can supersede a still-blocked automatic resume', async () => {
  const sound = harness();
  sound.mode('pending');
  const automatic = sound.api.prepareNotificationSound();
  sound.mode('ready');
  assert.equal(await sound.api.prepareNotificationSound({ userGesture: true }), true);
  assert.equal(sound.contexts[0].resumes, 2);
  assert.equal(sound.nodes.length, 0, 'preparation alone must never play');
  sound.resolve();
  assert.equal(await automatic, true);
  assert.equal(sound.timers.size, 0);
});

test('notification audio: blocked, hidden and closed contexts are handled safely', async () => {
  const sound = harness();
  sound.document.hidden = true;
  assert.equal(await sound.api.prepareNotificationSound(), false);
  assert.equal(sound.contexts.length, 0);
  sound.document.hidden = false;
  sound.mode('blocked');
  assert.equal(await sound.api.prepareNotificationSound(), false);
  assert.equal(sound.api.playNotificationSound(), false);
  sound.contexts[0].change('closed');
  sound.mode('ready');
  assert.equal(await sound.api.prepareNotificationSound(), true);
  assert.equal(sound.contexts.length, 2);
  assert.equal(sound.contexts[0].onstatechange, null);
  sound.document.hidden = true;
  assert.equal(sound.api.playNotificationSound(), false);
});

test('notification audio: mute stops immediately and survives unavailable storage', async () => {
  const sound = harness();
  await sound.api.prepareNotificationSound();
  sound.api.playNotificationSound();
  sound.failStorage();
  sound.api.setSoundEnabled('one', false);
  assert.equal(sound.api.soundEnabled('one'), false);
  assert.equal(sound.api.soundEnabled('two'), true);
  assert.ok(sound.nodes.every((n) => n.disconnected));
  sound.api.setSoundEnabled('one', true);
  assert.equal(sound.api.soundEnabled('one'), true);
});

test('notification audio: partial scheduling failure cleans up all nodes before OS fallback', async () => {
  const sound = harness();
  await sound.api.prepareNotificationSound();
  sound.failNode();
  assert.equal(sound.api.playNotificationSound(), false);
  assert.equal(sound.nodes.length, 2);
  assert.ok(sound.nodes.every((n) => n.disconnected));
});
