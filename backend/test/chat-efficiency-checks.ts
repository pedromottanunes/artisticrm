import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import type { User } from '../src/types.js';

export async function checkChatEfficiency(crm: CRM | MongoOperations, manager: User) {
  const config: InstagramConfig = {
    appSecret: 'synthetic-secret',
    verifyToken: 'synthetic-verify',
    accessToken: 'synthetic-token',
    accountId: '17841433333333333',
    graphApiVersion: 'v26.0',
    profileLookup: true,
  };
  const calls: string[] = [];
  const central = new InstagramCentral(crm, config, async (url) => {
    const id = new URL(String(url)).pathname.split('/').at(-1)!;
    calls.push(id);
    return id === 'rate-limited'
      ? new Response('', { status: 429 })
      : Response.json({ id, username: `profile_${id}` });
  });
  let sequence = 0;
  const ingest = async (sender: string) => {
    const bytes = Buffer.from(
      JSON.stringify({
        object: 'instagram',
        entry: [
          {
            id: config.accountId,
            messaging: [
              {
                sender: { id: sender },
                recipient: { id: config.accountId },
                timestamp: Date.now(),
                message: { mid: `efficiency-${++sequence}`, text: 'Teste' },
              },
            ],
          },
        ],
      }),
    );
    await central.receive(
      bytes,
      `sha256=${createHmac('sha256', config.appSecret).update(bytes).digest('hex')}`,
    );
    await central.drain();
  };
  await ingest('incomplete');
  assert.equal(calls.length, 0, 'Message ingestion does not call the profile API');
  await central.drainProfiles();
  assert.deepEqual(calls, ['incomplete']);
  await ingest('incomplete');
  await central.drainProfiles();
  assert.equal(calls.length, 1, 'Missing picture is cached instead of being fetched every message');

  for (const id of ['batch1', 'batch2', 'batch3', 'batch4']) await ingest(id);
  await central.drainProfiles();
  assert.equal(calls.length, 4, 'Each worker run enriches at most three profiles');
  await central.drainProfiles();
  assert.equal(calls.length, 5);
  await ingest('rate-limited');
  await central.drainProfiles();
  assert.equal(calls.length, 6);
  await ingest('rate-limited');
  await ingest('after-rate-limit');
  await central.drainProfiles();
  assert.equal(
    calls.length,
    6,
    'Rate limiting pauses optional lookups without blocking incoming messages',
  );
  const listed = await central.list(manager, 'all');
  assert.equal(listed.conversations.length, 7);
  const history = await central.messages(manager, String(listed.conversations[0].id));
  assert.ok(history.messages.length);
  assert.ok(
    history.messages.every(
      (message) =>
        !('_id' in message) &&
        !('fingerprint' in message) &&
        !('client_request_id' in message) &&
        !('sender_external_id' in message),
    ),
  );
  const stable = await central.list(manager, 'all');
  assert.deepEqual(stable, listed, 'Repeated lists have deterministic ordering');
}
