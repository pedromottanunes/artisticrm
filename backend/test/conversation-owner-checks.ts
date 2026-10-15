import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import type { CRM } from '../src/crm.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import { InstagramCentral } from '../src/instagram.js';
import { MessengerCentral } from '../src/messenger.js';
import { buildApp } from '../src/app.js';
import type { User } from '../src/types.js';

export async function checkConversationOwners(
  crm: CRM | MongoOperations,
  manager: User,
  users: User[],
  password: string,
) {
  const db = crm.db;
  const instagram = {
    appSecret: 'synthetic-owner-secret',
    verifyToken: 'synthetic-owner-verify',
    accountId: '17841433333333333',
    accessToken: 'synthetic-token',
    graphApiVersion: 'v26.0',
    profileLookup: false,
  };
  const messenger = {
    appSecret: instagram.appSecret,
    verifyToken: instagram.verifyToken,
    pageId: '123456789000',
    pageAccessToken: 'synthetic-token',
    graphApiVersion: 'v26.0',
  };
  const noNetwork: typeof fetch = async () => {
    throw new Error('No external calls in owner filtering');
  };
  const ig = new InstagramCentral(crm, instagram, noNetwork);
  const fb = new MessengerCentral(crm, messenger, noNetwork);
  const targetLeads: string[] = [];
  const archivedLeads: string[] = [];
  const change = async (
    table: 'opportunities' | 'conversations',
    id: string,
    field: string,
    value: unknown,
  ) => {
    if (db.kind === 'mongo') await db.update(table, { id }, { $set: { [field]: value } });
    else await db.query(`UPDATE ${table} SET ${field}=$2 WHERE id=$1`, [id, value]);
  };
  for (const [central, account, object] of [
    [ig, instagram.accountId, 'instagram'],
    [fb, messenger.pageId, 'page'],
  ] as const) {
    const ids: string[] = [];
    const leads: string[] = [];
    for (let index = 0; index < 5; index++) {
      const bytes = Buffer.from(
        JSON.stringify({
          object,
          entry: [
            {
              id: account,
              messaging: [
                {
                  sender: { id: randomUUID() },
                  recipient: { id: account },
                  timestamp: Date.now(),
                  message: { mid: randomUUID(), text: 'Teste de responsável' },
                },
              ],
            },
          ],
        }),
      );
      await central.receive(
        bytes,
        `sha256=${createHmac('sha256', instagram.appSecret).update(bytes).digest('hex')}`,
      );
      await central.drain();
    }
    const all = (await central.list(manager, 'all')).conversations;
    assert.equal(all.length, 5);
    for (let index = 0; index < all.length; index++) {
      const row = all[index];
      ids.push(String(row.id));
      leads.push(String(row.opportunity_id));
      const owner = index === 0 ? users[1].id : index === 4 ? null : users[0].id;
      await change('opportunities', String(row.opportunity_id), 'owner_id', owner);
      await change(
        'conversations',
        String(row.id),
        'last_message_at',
        new Date(Date.now() - index * 60_000),
      );
    }
    await change('opportunities', leads[3], 'non_commercial_reason', 'ADVERTISING');
    targetLeads.push(leads[2]);
    archivedLeads.push(leads[3]);
    const exact = await central.list(manager, 'all', undefined, 1, undefined, undefined, leads[2]);
    assert.deepEqual(
      exact.conversations.map((row) => row.id),
      [ids[2]],
      'An old target is fetched directly, independently of the first page',
    );
    assert.equal(exact.has_more, false);
    await assert.rejects(
      () => central.list(users[0], 'mine', undefined, 1, undefined, undefined, leads[2]),
      { code: 'FORBIDDEN' },
    );
    const first = await central.list(manager, 'all', undefined, 1, undefined, users[0].id);
    assert.deepEqual(
      first.conversations.map((row) => row.id),
      [ids[1]],
      'Filter must run before LIMIT',
    );
    assert.equal(first.has_more, true);
    assert.equal(first.conversations[0].can_send, false, 'Manager remains read-only');
    const second = await central.list(
      manager,
      'all',
      {
        at: new Date(String(first.conversations[0].last_message_at)),
        id: ids[1],
      },
      1,
      undefined,
      users[0].id,
    );
    assert.deepEqual(
      second.conversations.map((row) => row.id),
      [ids[2]],
    );
    assert.equal(second.has_more, false);
    assert.deepEqual(
      (
        await central.list(manager, 'non_commercial', undefined, 100, undefined, users[0].id)
      ).conversations.map((row) => row.id),
      [ids[3]],
    );
    assert.deepEqual(
      (await central.list(manager, 'all', undefined, 100, undefined, null)).conversations.map(
        (row) => row.id,
      ),
      [ids[4]],
    );
    await assert.rejects(
      () => central.list(users[0], 'mine', undefined, 100, undefined, users[1].id),
      { code: 'FORBIDDEN' },
    );
    await change('opportunities', leads[1], 'owner_id', users[1].id);
    assert.deepEqual(
      (
        await central.list(manager, 'all', undefined, 100, undefined, users[0].id)
      ).conversations.map((row) => row.id),
      [ids[2]],
      'Transfers follow current owner, not historical metrics owner',
    );
  }
  const { app } = await buildApp(db, {
    instagram,
    messenger,
    instagramFetch: noNetwork,
    messengerFetch: noNetwork,
    reconcile: false,
  });
  try {
    const login = async (user: User) => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { 'x-artisti-client': 'web' },
        payload: { email: user.email, password },
      });
      assert.equal(response.statusCode, 200, response.body);
      return { cookie: `artisti_session=${response.cookies[0].value}` };
    };
    const headers = await login(manager);
    const url = `/api/v1/conversations?view=all&owner_id=${users[0].id}`;
    const response = await app.inject({ url, headers });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      new Set(response.json().conversations.map((row: { channel: string }) => row.channel)),
      new Set(['instagram', 'messenger']),
    );
    assert.ok(
      response
        .json()
        .conversations.every((row: { owner_id: string }) => row.owner_id === users[0].id),
    );
    const cached = await app.inject({
      url: `${url}&revision=${response.json().revision}`,
      headers,
    });
    assert.equal(cached.json().unchanged, true);
    const outsidePage = `${url}&before_at=2000-01-01T00:00:00.000Z&before_id=${randomUUID()}`;
    for (const targetId of targetLeads) {
      const targeted = await app.inject({
        url: `${outsidePage}&target_opportunity_id=${targetId}`,
        headers,
      });
      assert.equal(targeted.statusCode, 200, targeted.body);
      assert.deepEqual(
        targeted.json().conversations,
        [],
        'The target does not change page membership',
      );
      assert.equal(targeted.json().has_more, false);
      assert.equal(targeted.json().next_before_id, null);
      assert.equal(targeted.json().target_conversation.opportunity_id, targetId);
      assert.equal(targeted.json().target_conversation.owner_id, users[0].id);
      assert.equal(targeted.json().target_conversation.can_send, false);
      const repeated = await app.inject({
        url: `${outsidePage}&target_opportunity_id=${targetId}&revision=${targeted.json().revision}`,
        headers,
      });
      assert.equal(repeated.json().unchanged, true);
      const wrongOwner = await app.inject({
        url: `/api/v1/conversations?owner_id=${users[1].id}&target_opportunity_id=${targetId}`,
        headers,
      });
      assert.equal(
        wrongOwner.json().target_conversation,
        null,
        'A target cannot bypass the consultant filter',
      );
    }
    for (const targetId of archivedLeads) {
      assert.equal(
        (await app.inject({ url: `${url}&target_opportunity_id=${targetId}`, headers })).json()
          .target_conversation,
        null,
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/v1/conversations?view=non_commercial&target_opportunity_id=${targetId}`,
            headers,
          })
        ).json().target_conversation.opportunity_id,
        targetId,
      );
    }
    assert.equal(
      (await app.inject({ url: `${url}&target_opportunity_id=${randomUUID()}`, headers })).json()
        .target_conversation,
      null,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/conversations?target_opportunity_id=invalid', headers }))
        .statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/v1/conversations?target_opportunity_id=${targetLeads[0]}`,
          headers: await login(users[0]),
        })
      ).statusCode,
      403,
    );
    const unassigned = await app.inject({
      url: '/api/v1/conversations?owner_id=unassigned',
      headers,
    });
    assert.equal(unassigned.json().conversations.length, 2);
    assert.ok(
      unassigned
        .json()
        .conversations.every((row: { owner_id: string | null }) => row.owner_id === null),
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/conversations?owner_id=invalid', headers })).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          url: `/api/v1/conversations?view=mine&owner_id=${users[0].id}`,
          headers,
        })
      ).statusCode,
      400,
    );
    assert.equal((await app.inject({ url, headers: await login(users[0]) })).statusCode, 403);
  } finally {
    await app.close();
  }
}
