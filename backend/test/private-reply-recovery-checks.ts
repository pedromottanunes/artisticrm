import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import { deleteLeadData } from '../src/lead-deletion.js';

export async function checkPrivateReplyRecovery(
  crm: CRM | MongoOperations,
  user: User,
  manager: User,
) {
  const db = crm.db;
  const config: InstagramConfig = {
    appSecret: 'private-reply-recovery-test',
    verifyToken: 'synthetic-verify',
    accessToken: 'synthetic-token-never-used',
    accountId: '17841499999000111',
    graphApiVersion: 'v26.0',
    profileLookup: false,
  };
  const row = async (table: string, key: string, value: string): Promise<any> =>
    db.kind === 'mongo'
      ? db.one(table, { [key]: value })
      : (await db.query(`SELECT * FROM ${table} WHERE ${key}=$1`, [value])).rows[0];
  const count = async (table: string) =>
    db.kind === 'mongo'
      ? db.count(table)
      : Number((await db.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
  const ingest = async (central: InstagramCentral, event: unknown) => {
    const body = Buffer.from(JSON.stringify(event));
    await central.receive(
      body,
      `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
    );
    await central.drain();
  };
  let sequence = 0;
  for (const recovery of [
    'replay',
    'worker',
    'inbound',
    'conflict',
    'deleted',
    'receipt_retry',
    'receipt_commit_ack',
  ] as const) {
    sequence++;
    const sender = `100000${sequence}`;
    const recipient = `200000${sequence}`;
    let posts = 0;
    const recipients: unknown[] = [];
    const request: typeof fetch = async (_url, init) => {
      if (init?.method === 'POST') {
        posts++;
        recipients.push(JSON.parse(String(init.body)).recipient);
        return Response.json({
          recipient_id: recipient,
          message_id: `confirmed-${sequence}-${posts}`,
        });
      }
      return Response.json({ timestamp: new Date().toISOString() });
    };
    const central = new InstagramCentral(crm, config, request);
    await ingest(central, {
      object: 'instagram',
      entry: [
        {
          id: config.accountId,
          time: Math.floor(Date.now() / 1000),
          changes: [
            {
              field: 'comments',
              value: {
                id: `300000${sequence}`,
                from: { id: sender, username: `test_${sequence}` },
                text: 'Teste de recuperação',
              },
            },
          ],
        },
      ],
    });
    const item = (await central.comments.list(user)).comments.find(
      (comment) => comment.sender_id === sender,
    )!;
    const claim = await central.comments.claim(user, item.id, item.version);
    const leadCount = await count('opportunities');
    if (recovery === 'receipt_retry' || recovery === 'receipt_commit_ack') {
      // Lose the transaction once, either before commit or just after its acknowledgement.
      // Only database persistence may be retried; the Meta POST count must stay at one.
      const transactionName = db.kind === 'mongo' ? 'atomic' : 'transaction';
      const store = db as any;
      const original = store[transactionName].bind(db);
      let injected = false;
      const savedReceipt = async (tx: any) =>
        db.kind === 'mongo'
          ? tx.one('messages', { 'private_reply_receipt.recipient_id': recipient })
          : (
              await tx.query(
                "SELECT id FROM messages WHERE private_reply_receipt->>'recipient_id'=$1",
                [recipient],
              )
            ).rows[0];
      store[transactionName] = async (work: any, ...args: unknown[]) => {
        const value = await original(
          async (tx: any) => {
            const result = await work(tx);
            if (!injected && recovery === 'receipt_retry' && (await savedReceipt(tx))) {
              injected = true;
              throw new Error('Simulated receipt rollback');
            }
            return result;
          },
          ...args,
        );
        if (!injected && recovery === 'receipt_commit_ack' && (await savedReceipt(db))) {
          injected = true;
          throw new Error('Simulated lost commit acknowledgement');
        }
        return value;
      };
      try {
        assert.equal(
          (await central.send(user, claim.conversation_id, 'Olá, podemos ajudar?', randomUUID()))
            .status,
          'sent',
        );
      } finally {
        store[transactionName] = original;
      }
      assert.equal(injected, true);
      assert.equal(posts, 1);
      assert.equal(
        (await row('conversations', 'id', claim.conversation_id)).instagram_recipient_id,
        recipient,
      );
      continue;
    }
    // Fault injection AFTER the identity writes: the entire finalization must roll back.
    const internals = central.comments as any;
    const bind = internals.bindRecipient.bind(central.comments);
    internals.bindRecipient = async (...args: unknown[]) => {
      await bind(...args);
      throw new Error('Simulated failure during finalization');
    };
    const key = randomUUID();
    await assert.rejects(
      central.send(user, claim.conversation_id, 'Olá, podemos ajudar?', key),
      (error: any) => error.code === 'INSTAGRAM_BINDING_PENDING',
    );
    let conversation = await row('conversations', 'id', claim.conversation_id);
    const messageId = conversation.private_reply_message_id;
    let message = await row('messages', 'id', messageId);
    assert.equal(message.private_reply_binding_pending, true);
    assert.equal(message.private_reply_receipt.recipient_id, recipient);
    assert.equal(message.status, 'sending');
    assert.equal(Boolean(conversation.instagram_recipient_id), false);
    assert.equal(
      Boolean(await row('contact_identities', 'external_user_id', recipient)),
      false,
      'Failed transaction cannot leave a partial identity binding',
    );
    await central.recoverStaleSends(0);
    assert.equal(
      (await row('messages', 'id', messageId)).status,
      'sending',
      'Known confirmations are not downgraded to unknown',
    );

    const restarted = new InstagramCentral(crm, config, request);
    const replyId = `reply-recovery-${sequence}`;
    const reply = {
      object: 'instagram',
      entry: [
        {
          id: config.accountId,
          messaging: [
            {
              sender: { id: recipient },
              recipient: { id: config.accountId },
              timestamp: Date.now(),
              message: { mid: replyId, text: 'Quero continuar' },
            },
          ],
        },
      ],
    };
    if (recovery === 'deleted') {
      const remove = (tx: any) =>
        deleteLeadData(tx, manager, claim.opportunity_id, {
          expected_version: 1,
          confirmation: 'EXCLUIR',
        });
      if (db.kind === 'mongo') await db.atomic(remove);
      else await db.transaction(remove);
      await restarted.comments.recoverPrivateReplies();
      assert.equal(Boolean(await row('messages', 'id', messageId)), false);
      assert.equal(Boolean(await row('contact_identities', 'external_user_id', recipient)), false);
      assert.equal(posts, 1);
      continue;
    }
    if (recovery === 'conflict') {
      // Existing identity from another contact must not be stolen or merged.
      const unrelated = await crm.ingest(
        {
          name: 'Outro lead',
          interest: '',
          unit: 'Teste',
          source: 'Teste',
          identity: {
            provider: 'instagram',
            account_id: config.accountId,
            external_user_id: recipient,
          },
        },
        `other-${sequence}`,
        null,
      );
      const identity = await row('contact_identities', 'external_user_id', recipient);
      await restarted.comments.recoverPrivateReplies();
      await ingest(restarted, reply);
      assert.equal((await row('messages', 'id', messageId)).private_reply_binding_pending, true);
      assert.equal(
        Boolean((await row('conversations', 'id', claim.conversation_id)).instagram_recipient_id),
        false,
      );
      assert.equal(
        (await row('contact_identities', 'external_user_id', recipient)).contact_id,
        identity.contact_id,
      );
      assert.equal(Boolean(await row('opportunities', 'id', unrelated.id)), true);
      assert.equal(
        Boolean(await row('messages', 'external_message_id', replyId)),
        false,
        'Conflicting incoming identity stays pending for review',
      );
      assert.equal(posts, 1);
      continue;
    }
    if (recovery === 'replay') {
      await assert.rejects(
        restarted.send(user, claim.conversation_id, 'Texto diferente', key),
        /Chave reutilizada/,
      );
      assert.equal(
        (await restarted.send(user, claim.conversation_id, 'Olá, podemos ajudar?', key)).status,
        'sent',
      );
    } else if (recovery === 'worker') {
      await Promise.all([
        restarted.comments.recoverPrivateReplies(),
        new InstagramCentral(crm, config, request).comments.recoverPrivateReplies(),
      ]);
    } else {
      await ingest(central, reply);
      assert.equal(
        await count('opportunities'),
        leadCount,
        'Do not create another lead while its binding is failing',
      );
      assert.equal(Boolean(await row('messages', 'external_message_id', replyId)), false);
      if (db.kind === 'mongo')
        await db.update(
          'instagram_webhook_inbox',
          { processed_at: null },
          { $set: { available_at: new Date(0) } },
        );
      else
        await db.query(
          'UPDATE instagram_webhook_inbox SET available_at=$1 WHERE processed_at IS NULL',
          [new Date(0)],
        );
      await restarted.drain();
    }
    message = await row('messages', 'id', messageId);
    conversation = await row('conversations', 'id', claim.conversation_id);
    assert.equal(message.status, 'sent');
    assert.equal(message.private_reply_binding_pending, false);
    assert.equal(conversation.instagram_recipient_id, recipient);
    assert.equal(
      (await row('contact_identities', 'external_user_id', recipient)).contact_id,
      conversation.contact_id,
    );
    if (recovery !== 'inbound') await ingest(restarted, reply);
    assert.equal(
      (await row('messages', 'external_message_id', replyId)).conversation_id,
      claim.conversation_id,
    );
    assert.equal((await row('opportunities', 'id', claim.opportunity_id)).owner_id, user.id);
    assert.equal(await count('opportunities'), leadCount);
    await restarted.send(user, claim.conversation_id, 'Olá, podemos ajudar?', key);
    assert.equal(posts, 1, 'Recovery and replay must never resend to Meta');
    await restarted.send(user, claim.conversation_id, 'Podemos continuar por aqui.', randomUUID());
    assert.deepEqual(
      recipients.at(-1),
      { id: recipient },
      'Future Directs use the recovered recipient ID',
    );
    assert.equal(posts, 2, 'Only an explicit new message may cause another Meta POST');
  }
}
