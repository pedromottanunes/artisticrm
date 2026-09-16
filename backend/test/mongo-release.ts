import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { MongoMemoryReplSet } from 'mongodb-memory-server-core';

// Exercise the actual compiled Render entry point, never a configured Atlas database.
const replica = await MongoMemoryReplSet.create({
  binary: { version: '8.0.12' },
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
const root = fileURLToPath(new URL('../../', import.meta.url));
const base = `http://127.0.0.1:${port}`;
let server: ChildProcess | undefined;
let output = '';
let access = { login: 'master-release', password: '1' };
const start = (bootstrap = true, overrides: NodeJS.ProcessEnv = {}) => {
  output = '';
  server = spawn(process.execPath, ['backend/dist/server.js'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      MONGODB_URI: replica.getUri(),
      MONGODB_DB: 'artisti_release_test',
      DATABASE_URL: '',
      APP_ORIGIN: 'https://staging.example.test',
      WHATSAPP_ENABLED: 'false',
      BOOTSTRAP_ADMIN_LOGIN: bootstrap ? 'master-release' : '',
      BOOTSTRAP_ADMIN_EMAIL: '',
      BOOTSTRAP_ADMIN_PASSWORD: bootstrap ? '1' : '',
      ...overrides,
    },
  });
  server.stdout!.on('data', (chunk) => {
    output += chunk;
  });
  server.stderr!.on('data', (chunk) => {
    output += chunk;
  });
  return server;
};
const stop = async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = once(server, 'exit');
  server.kill();
  await exited;
};
const ready = async () => {
  for (let n = 0; n < 150; n++) {
    assert.equal(server!.exitCode, null, output);
    try {
      if ((await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {
      /* booting */
    }
    await delay(100);
  }
  assert.fail(`Compiled server did not become healthy: ${output}`);
};
const login = async () => {
  const response = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Artisti-Client': 'web',
      Origin: 'https://staging.example.test',
    },
    body: JSON.stringify(access),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('set-cookie')!, /Secure/);
  return response.headers.get('set-cookie')!.split(';')[0];
};
try {
  start();
  await ready();
  const html = await (await fetch(base)).text();
  assert.match(html, /Artisti/);
  const asset = html.match(/src="([^"]+\.js)"/)!;
  assert.doesNotMatch(
    await (await fetch(`${base}${asset[1]}`)).text(),
    /Artisti\.demo2026|demo\.artisti\.local/,
  );
  let cookie = await login();
  let workspace = await fetch(`${base}/api/v1/workspace`, { headers: { cookie } });
  assert.equal(workspace.status, 200);
  const first = await workspace.json();
  assert.equal(first.users.length, 1);
  assert.equal(first.opportunities.length, 0);
  assert.equal(first.demo, false);
  await stop();

  let resetOutput = '';
  const reset = spawn(process.execPath, ['backend/dist/reset-master.js'], {
    cwd: root,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MONGODB_URI: replica.getUri(),
      MONGODB_DB: 'artisti_release_test',
      DATABASE_URL: '',
      MASTER_LOGIN: 'master-reset',
      MASTER_PASSWORD: 'masterartisti',
    },
  });
  reset.stdout.on('data', (chunk) => (resetOutput += chunk));
  reset.stderr.on('data', (chunk) => (resetOutput += chunk));
  const [resetCode] = await once(reset, 'exit');
  assert.equal(resetCode, 0, resetOutput);
  assert.match(resetOutput, /master-reset/);
  access = { login: 'master-reset', password: 'masterartisti' };

  start(false);
  await ready();
  cookie = await login();
  workspace = await fetch(`${base}/api/v1/workspace`, { headers: { cookie } });
  assert.equal((await workspace.json()).user.id, first.user.id);
  await stop();
  const invalid = start(false, { DATABASE_URL: 'postgresql://invalid/test' });
  const [code] = await once(invalid, 'exit');
  assert.notEqual(code, 0);
  assert.match(output, /nunca ambos/);
  console.info(
    'MongoDB release: servidor compilado, login simples, senha curta, reinício sem bootstrap e configuração ambígua rejeitada — OK.',
  );
} finally {
  await stop();
  await replica.stop();
}
