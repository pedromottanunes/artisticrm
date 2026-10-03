import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import { signalWithTimeout } from '../../frontend/src/abort.js';

test('browser request: timeout cancels once and leaves the parent usable for a retry', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const request = signalWithTimeout(parent.signal, 1000);
  const aborted = t.mock.fn();
  request.signal.addEventListener('abort', aborted);
  t.mock.timers.tick(999);
  assert.equal(request.signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(request.signal.aborted, true);
  assert.equal(parent.signal.aborted, false);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  parent.abort();
  t.mock.timers.tick(1000);
  assert.equal(aborted.mock.callCount(), 1);
});

test('browser request: changing conversation cancels immediately and releases the listener', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const request = signalWithTimeout(parent.signal, 1000);
  const aborted = t.mock.fn();
  request.signal.addEventListener('abort', aborted);
  parent.abort();
  assert.equal(request.signal.aborted, true);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  request.dispose();
  t.mock.timers.tick(2000);
  assert.equal(aborted.mock.callCount(), 1);
});

test('browser request: an already canceled parent prevents a new request', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  parent.abort();
  const request = signalWithTimeout(parent.signal, 1000);
  assert.equal(request.signal.aborted, true);
  assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
  request.dispose();
});

test('browser request: finished polls and media probes do not retain listeners or timeouts', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const parent = new AbortController();
  const requests = Array.from({ length: 100 }, () => {
    const request = signalWithTimeout(parent.signal, 1000);
    request.dispose();
    request.dispose();
    assert.equal(getEventListeners(parent.signal, 'abort').length, 0);
    return request;
  });
  parent.abort();
  t.mock.timers.tick(2000);
  assert.ok(requests.every((request) => !request.signal.aborted));
});
