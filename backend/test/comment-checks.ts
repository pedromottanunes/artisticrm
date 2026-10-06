import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import { commentMessagingMode } from '../src/instagram-comments.js';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';
import { deleteLeadData } from '../src/lead-deletion.js';
import { attendantPoolCounts } from '../src/pool-counts.js';

export async function checkComments(crm: CRM | MongoOperations, users: User[], manager: User) {
  const db = crm.db;
  const config: InstagramConfig = {
    appSecret: 'comment-test-secret',
    verifyToken: 'comment-verify-test-token-32-characters',
    accessToken: 'synthetic-token-not-for-network',
    accountId: '17841499999990000',
    graphApiVersion: 'v26.0',
    profileLookup: false,
  };
  const sent: any[] = [];
  let timestamp = new Date().toISOString();
  let failSend = false;
  let timestampRequests = 0;
  const central = new InstagramCentral(crm, config, async (_url, init) => {
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      sent.push(body);
      if (failSend) throw new Error('Simulated timeout');
      return Response.json({ recipient_id: '123456789', message_id: `mid-${randomUUID()}` });
    }
    timestampRequests++;
    return Response.json({ timestamp });
  });
  const ingest = async (payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload));
    await central.receive(
      body,
      `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
    );
    await central.drain();
  };
  const comment = (id: string, sender = '123456789', time = Date.now(), field = 'comments') => ({
    object: 'instagram',
    entry: [
      {
        id: config.accountId,
        time: Math.floor(time / 1000),
        changes: [
          {
            field,
            value: {
              id,
              from: { id: sender, username: 'teste.comentario' },
              text: 'Quero uma avaliação!',
              media: { id: '11111111111111111' },
            },
          },
        ],
      },
    ],
  });
  const count = async (table: string) =>
    db.kind === 'mongo'
      ? db.count(table)
      : Number((await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const countBefore = await count('opportunities');
  await ingest(comment('1001'));
  await ingest(comment('1001'));
  await ingest(comment('1002'));
  await ingest(comment('1003', config.accountId));
  await ingest(comment('1004', '999', Date.now(), 'live_comments'));
  assert.equal(
    await count('opportunities'),
    countBefore,
    'Unclaimed comments must not enter distribution',
  );
  const list = await central.comments.list(users[0]);
  assert.equal(
    list.comments.length,
    1,
    'Comments from same profile are grouped; own/live comments ignored',
  );
  assert.equal(list.comments[0].comment_count, 2);
  const initialCounts = await attendantPoolCounts(db, users[0], config.accountId, new Date());
  const pooledLeads =
    db.kind === 'mongo'
      ? await db.count('opportunities', { state: 'POOL' })
      : Number(
          (
            await db.query<{ count: number }>(
              "SELECT count(*)::integer AS count FROM opportunities WHERE state='POOL'",
            )
          ).rows[0].count,
        );
  assert.equal(initialCounts.leads, pooledLeads, 'The badge counts every normal pool lead');
  assert.equal(initialCounts.comments, 1, 'The badge counts profiles, not repeated comments');
  await assert.rejects(
    attendantPoolCounts(db, manager, config.accountId, new Date()),
    /somente para consultores/i,
  );
  const item = list.comments[0];
  await assert.rejects(
    central.comments.claim(manager, item.id, item.version),
    /Somente consultores/,
  );
  const race = await Promise.allSettled(
    users.slice(0, 2).map((user) => central.comments.claim(user, item.id, item.version)),
  );
  assert.equal(
    race.filter((result) => result.status === 'fulfilled').length,
    1,
    'Only one consultant can claim',
  );
  const winnerIndex = race.findIndex((result) => result.status === 'fulfilled');
  const winner = users[winnerIndex];
  const loser = users[1 - winnerIndex];
  const claimed = (
    race[winnerIndex] as PromiseFulfilledResult<{ opportunity_id: string; conversation_id: string }>
  ).value;
  assert.deepEqual(
    await central.comments.claim(winner, item.id, item.version),
    claimed,
    'Claim retry is idempotent',
  );
  assert.equal((await central.comments.list(loser)).comments.length, 0);
  assert.equal(
    (await attendantPoolCounts(db, loser, config.accountId, new Date())).comments,
    0,
    'Claimed profiles leave the comment-pool badge',
  );
  let thread = await central.messages(winner, claimed.conversation_id);
  assert.equal(thread.messaging_mode, 'private_reply');
  assert.equal(thread.can_send, true);
  assert.equal(thread.messages[0].type, 'instagram_comment');
  assert.equal((await central.list(winner)).conversations[0].can_send, true);
  await assert.rejects(
    central.send(loser, claimed.conversation_id, 'Olá', randomUUID()),
    /Assuma|pertence/,
  );
  await assert.rejects(central.messages(loser, claimed.conversation_id), /Assuma/);
  const key = randomUUID();
  await Promise.all([
    central.send(winner, claimed.conversation_id, 'Olá! Podemos ajudar?', key),
    central.send(winner, claimed.conversation_id, 'Olá! Podemos ajudar?', key),
  ]);
  assert.deepEqual(sent[0].recipient, { comment_id: item.comment_id });
  await central.send(winner, claimed.conversation_id, 'Olá! Podemos ajudar?', key);
  assert.equal(sent.length, 1, 'Request retry must not hit Meta again');
  assert.equal(timestampRequests, 1, 'Concurrent private replies share timestamp verification');
  await assert.rejects(
    central.send(winner, claimed.conversation_id, 'Outra mensagem', randomUUID()),
    /Aguarde/,
  );
  assert.equal(
    (await central.messages(winner, claimed.conversation_id)).messaging_mode,
    'waiting_reply',
  );
  assert.equal((await central.list(winner)).conversations[0].can_send, false);
  // A new comment from this same person cannot grant another private approach.
  await ingest(comment('1005'));
  assert.equal((await central.comments.list(loser)).comments.length, 0);
  await ingest({
    object: 'instagram',
    entry: [
      {
        id: config.accountId,
        messaging: [
          {
            sender: { id: '123456789' },
            recipient: { id: config.accountId },
            timestamp: Date.now(),
            message: { mid: 'real-reply-comment-test', text: 'Sim, quero saber mais' },
          },
        ],
      },
    ],
  });
  thread = await central.messages(winner, claimed.conversation_id);
  assert.equal(thread.messaging_mode, 'direct');
  assert.equal(thread.can_send, true);
  assert.equal(
    await count('opportunities'),
    countBefore + 1,
    'Reply reuses the already claimed lead',
  );
  await central.send(winner, claimed.conversation_id, 'Vamos agendar?', randomUUID());
  assert.deepEqual(sent[1].recipient, { id: '123456789' });
  assert.equal(
    (await central.list(loser)).conversations.length,
    0,
    'Owner preserved after response',
  );

  await ingest(comment('2001', '987654321'));
  let next = (await central.comments.list(loser)).comments[0];
  const expired = await central.comments.claim(loser, next.id, next.version);
  timestamp = new Date(Date.now() - 8 * 86_400_000).toISOString();
  await assert.rejects(
    central.send(loser, expired.conversation_id, 'Fora do prazo', randomUUID()),
    /sete dias/,
  );
  assert.equal(
    sent.length,
    2,
    'Actual comment timestamp prevents late send, even on delayed webhook',
  );
  assert.equal((await central.messages(loser, expired.conversation_id)).messaging_mode, 'expired');

  timestamp = new Date().toISOString();
  await ingest(comment('3001', '888888888'));
  next = (await central.comments.list(loser)).comments[0];
  const uncertain = await central.comments.claim(loser, next.id, next.version);
  failSend = true;
  await assert.rejects(
    central.send(loser, uncertain.conversation_id, 'Tentativa', randomUUID()),
    /não confirmou/,
  );
  assert.equal(
    (await central.messages(loser, uncertain.conversation_id)).messaging_mode,
    'send_unconfirmed',
  );
  await assert.rejects(
    central.send(loser, uncertain.conversation_id, 'Tentativa diferente', randomUUID()),
    /Aguarde/,
  );
  assert.equal(sent.length, 3, 'Uncertain delivery must not be retried with a new key');

  await ingest(comment('4001', '777777777'));
  next = (await central.comments.list(loser)).comments[0];
  await central.comments.ignore(loser, next.id, next.version);
  assert.equal((await central.comments.list(loser)).comments.length, 0);
  await assert.rejects(central.comments.claim(winner, next.id, next.version), /mudou/);

  const time = new Date();
  assert.equal(
    commentMessagingMode(
      { private_reply_comment_id: '1', last_inbound_at: new Date(time.getTime() - 86_400_000) },
      null,
      time,
    ),
    'expired',
    '24h boundary closes the normal conversation',
  );

  // Lead deletion also removes comments and blocks redelivery from recreating them.
  const remove = async (tx: any) =>
    deleteLeadData(tx, manager, claimed.opportunity_id, {
      expected_version: 1,
      confirmation: 'EXCLUIR',
    });
  if (db.kind === 'mongo') await db.atomic(remove);
  else await db.transaction(remove);
  await ingest(comment('1001'));
  const leftovers =
    db.kind === 'mongo'
      ? await db.count('instagram_comments', { sender_id: '123456789' })
      : Number(
          (
            await db.query<{ n: number }>(
              "SELECT count(*) AS n FROM instagram_comments WHERE sender_id='123456789'",
            )
          ).rows[0].n,
        );
  assert.equal(leftovers, 0);

  // Cursor pagination must retain every profile, even when an entire webhook batch shares a timestamp.
  const batch = comment('5000', '5000');
  batch.entry[0].changes = Array.from(
    { length: 35 },
    (_, index) => comment(String(5000 + index), String(5000 + index)).entry[0].changes[0],
  );
  const bytes = Buffer.from(JSON.stringify(batch));
  await central.receive(
    bytes,
    `sha256=${createHmac('sha256', config.appSecret).update(bytes).digest('hex')}`,
  );
  await central.drain(50);
  const first = await central.comments.list(winner);
  assert.equal(first.comments.length, 30);
  assert.ok(first.next_cursor);
  const second = await central.comments.list(winner, first.next_cursor);
  assert.equal(second.comments.length, 5);
  assert.equal(second.next_cursor, null);
  assert.equal(new Set([...first.comments, ...second.comments].map((row) => row.id)).size, 35);
  await assert.rejects(central.comments.list(winner, 'invalid-cursor'));

  const previewRequests: string[] = [];
  const previews = new InstagramCentral(crm, { ...config, profileLookup: true }, async (url) => {
    previewRequests.push(String(url));
    return Response.json({
      permalink: 'https://www.instagram.com/p/test-publication/',
      media_type: 'IMAGE',
      media_url: 'https://scontent.cdninstagram.com/test.jpg',
    });
  });
  const previewBody = Buffer.from(JSON.stringify(comment('9001', '9001')));
  await previews.receive(
    previewBody,
    `sha256=${createHmac('sha256', config.appSecret).update(previewBody).digest('hex')}`,
  );
  await previews.drain();
  assert.equal(
    previewRequests.length,
    0,
    'No network metadata lookup may block comment/Direct ingestion',
  );
  await previews.comments.enrichPreviews();
  assert.equal(
    previewRequests.length,
    1,
    'Comments on the same post share a single metadata request',
  );
  assert.ok(previewRequests[0].startsWith('https://graph.instagram.com/'));
  const preview = (await previews.comments.list(winner)).comments[0];
  assert.equal(preview.permalink, 'https://www.instagram.com/p/test-publication/');
  assert.equal(preview.thumbnail_url, 'https://scontent.cdninstagram.com/test.jpg');
  await ingest(comment('9002', '9002'));
  await previews.comments.enrichPreviews();
  assert.equal(previewRequests.length, 1, 'A later comment reuses the cached post metadata');
  const cached = (await previews.comments.list(winner)).comments.find(
    (row) => row.sender_id === '9002',
  );
  assert.equal(cached?.thumbnail_url, preview.thumbnail_url);
}
