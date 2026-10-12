import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import type { Database } from '../src/db.js';
import { initializeMongo, type MongoStore } from '../src/mongo-store.js';
import type { User, Opportunity } from '../src/types.js';
import { InstagramCentral, type InstagramConfig } from '../src/instagram.js';
import { qualityDetails } from '../src/lead-quality.js';

export async function checkLeadQuality(db: Database | MongoStore, manager: User, users: User[]) {
  let clock = new Date('2026-10-10T12:00:00Z');
  const config: InstagramConfig = {
    appSecret: 'test-quality-secret',
    verifyToken: 'test-quality-verify-token-32-chars',
    accountId: '17841435843172523',
    accessToken: 'IGAA-local-only',
    graphApiVersion: 'v26.0',
    profileLookup: false,
  };
  const { app, crm } = await buildApp(db, {
    reconcile: false,
    clock: () => clock,
    instagram: config,
    instagramFetch: async () => {
      throw new Error('No external request expected');
    },
  });
  const central = new InstagramCentral(crm, config, async (url, init) => {
    if (String(url).endsWith('/messages') && init?.method === 'POST')
      return new Response(
        JSON.stringify({ recipient_id: '88100000000000123', message_id: randomUUID() }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    throw new Error('No other external request expected');
  });
  const all = async (table: string): Promise<Record<string, any>[]> =>
    db.kind === 'mongo' ? db.many(table) : (await db.query(`SELECT * FROM ${table}`)).rows;
  const lead = async (id: string) =>
    (await all('opportunities')).find((row) => row.id === id) as Opportunity;
  const change = async (table: string, id: string | number, values: Record<string, unknown>) => {
    if (db.kind === 'mongo') await db.update(table, { id }, { $set: values });
    else
      await db.query(
        `UPDATE ${table} SET ${Object.keys(values)
          .map((key, i) => `${key}=$${i + 2}`)
          .join(',')} WHERE id=$1`,
        [id, ...Object.values(values)],
      );
  };
  const headers = new Map<string, Record<string, string>>();
  for (const user of [manager, ...users]) {
    const token = randomUUID();
    const session = {
      token_hash: tokenHash(token),
      user_id: user.id,
      auth_version: user.auth_version,
      expires_at: new Date('2030-01-01T00:00:00Z'),
    };
    if (db.kind === 'mongo') await db.insert('sessions', session);
    else
      await db.query(
        'INSERT INTO sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)',
        Object.values(session),
      );
    headers.set(user.id, { cookie: `artisti_session=${token}`, 'x-artisti-client': 'web' });
  }
  const mark = (user: User, row: Opportunity, reason: string | null = 'ADVERTISING') =>
    app.inject({
      method: 'PUT',
      url: `/api/v1/opportunities/${row.id}/quality`,
      headers: headers.get(user.id),
      payload: { reason, expected_version: row.version },
    });
  let n = 0;
  const create = async () =>
    crm.ingest(
      {
        name: `Qualidade ${++n}`,
        phone: `554897770${String(n).padStart(4, '0')}`,
        interest: '',
        unit: '',
        source: 'Teste',
      },
      randomUUID(),
      null,
    );
  try {
    await change('distribution_settings', 1, { last_position: 0 });
    for (const user of users)
      await change('users', user.id, {
        queue_weight: 1,
        queue_credit: 0,
        active: true,
        queue_enabled: true,
      });
    const first = await create();
    await crm.claim(users[0], first.id, 'reservation', 1, randomUUID());
    const claimed = await lead(first.id);
    assert.equal(claimed.claim_mode, 'reservation');
    assert.equal((await mark(users[1], claimed)).statusCode, 403);
    assert.equal((await mark(users[0], claimed, 'INVALID')).statusCode, 400);
    // There is deliberately no marking deadline, even after the original reservation expired.
    clock = new Date(clock.getTime() + 15 * 86400_000);
    const duplicates = await Promise.all([mark(users[0], claimed), mark(users[0], claimed)]);
    duplicates.forEach((response) => assert.equal(response.statusCode, 200, response.body));
    assert.equal((await all('lead_compensations')).length, 1);
    assert.equal(
      (await all('audit_events')).filter((e) => e.kind === 'lead.non_commercial').length,
      1,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/queue/me', headers: headers.get(users[0].id) })).json()
        .next,
      true,
    );
    assert.equal(
      (await app.inject({ url: '/api/v1/queue/me', headers: headers.get(users[1].id) })).json()
        .next,
      false,
    );
    // Concurrent arrivals consume the credit once and leave the ordinary cursor intact.
    const pair = await Promise.all([create(), create()]);
    assert.deepEqual(
      (await Promise.all(pair.map((row) => lead(row.id)))).map((row) => row.reserved_to).sort(),
      [users[0].id, users[1].id].sort(),
    );
    assert.equal((await all('lead_compensations'))[0].status, 'used');
    const third = await create();
    assert.equal((await lead(third.id)).reserved_to, users[2].id);
    // Restoring never retracts a delivered reservation and never grants the same lead twice.
    assert.equal((await mark(manager, await lead(first.id), null)).statusCode, 200);
    assert.equal((await mark(users[0], await lead(first.id), 'JOB_SEEKER')).statusCode, 200);
    const markedWhatsApp = await app.inject({
      method: 'POST',
      url: `/api/v1/opportunities/${first.id}/whatsapp-link`,
      headers: headers.get(users[0].id),
      payload: {},
    });
    assert.equal(markedWhatsApp.statusCode, 200, markedWhatsApp.body);
    assert.match(markedWhatsApp.json().url, /^https:\/\/wa\.me\//);
    assert.equal((await all('lead_compensations')).length, 1);
    assert.equal((await all('lead_compensations'))[0].status, 'used');
    // Even the original recipient claiming their own expired reservation does so through the pool.
    const pool = await create();
    const poolRow = await lead(pool.id);
    const original = users.find((user) => user.id === poolRow.reserved_to)!;
    clock = new Date(clock.getTime() + 11 * 60_000);
    await crm.expire();
    await crm.claim(original, pool.id, 'pool', (await lead(pool.id)).version, randomUUID());
    assert.equal((await lead(pool.id)).claim_mode, 'pool');
    const poolMarked = await mark(original, await lead(pool.id), 'POLITICAL_VIDEO');
    assert.equal(poolMarked.statusCode, 200, poolMarked.body);
    assert.equal(poolMarked.json().compensation_status, null);
    assert.equal((await all('lead_compensations')).length, 1);
    const archive = (
      await app.inject({
        url: '/api/v1/lead-lists?category=NON_COMMERCIAL',
        headers: headers.get(manager.id),
      })
    ).json();
    assert.equal(archive.total, 2);
    assert.equal(archive.counts.ALL, 3);
    const report = (
      await app.inject({
        url: '/api/v1/reports/overview?from=2026-10-10&to=2026-10-25',
        headers: headers.get(manager.id),
      })
    ).json();
    assert.equal(report.quality.non_commercial, 2);
    assert.equal(report.funnel.find((r: { key: string }) => r.key === 'RECEIVED').count, 3);
    assert.equal(
      report.pool_claimed_by_user.some((r: { lead_ids: string[] }) => r.lead_ids.includes(pool.id)),
      false,
    );
    assert.equal(
      (await crm.snapshot(manager)).opportunities.some((row) => row.id === first.id),
      false,
    );

    const comment = async (id: string, sender = '88100000000000123') => {
      const body = Buffer.from(
        JSON.stringify({
          object: 'instagram',
          entry: [
            {
              id: config.accountId,
              time: Math.floor(Date.now() / 1000),
              changes: [
                {
                  field: 'comments',
                  value: {
                    id,
                    from: { id: sender, username: 'quality.test' },
                    text: 'Comentário não comercial',
                    media: { id: '11111111111111111' },
                  },
                },
              ],
            },
          ],
        }),
      );
      await central.receive(
        body,
        `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
      );
      await central.drain();
    };
    await comment('99000000000000001');
    assert.equal((await all('instagram_comments')).length, 1);
    const receive = async (mid: string) => {
      const body = Buffer.from(
        JSON.stringify({
          object: 'instagram',
          entry: [
            {
              id: config.accountId,
              messaging: [
                {
                  sender: { id: '88100000000000123' },
                  recipient: { id: config.accountId },
                  timestamp: clock.getTime(),
                  message: { mid, text: 'Mensagem de teste' },
                },
              ],
            },
          ],
        }),
      );
      await central.receive(
        body,
        `sha256=${createHmac('sha256', config.appSecret).update(body).digest('hex')}`,
      );
      await central.drain();
    };
    await receive('quality-initial');
    const conversation = (await central.list(manager, 'all')).conversations[0];
    assert.ok(conversation);
    const incoming = await lead(String(conversation.opportunity_id));
    const consultant = users.find((user) => user.id === incoming.reserved_to)!;
    await crm.claim(consultant, incoming.id, 'reservation', incoming.version, randomUUID());
    const beforeMark = await lead(incoming.id);
    const result = await mark(consultant, beforeMark, 'NON_COMMERCIAL_MENTION');
    assert.equal(result.statusCode, 200, result.body);
    const afterMark = await lead(incoming.id);
    const cancelledAppointment = {
      id: randomUUID(),
      opportunity_id: incoming.id,
      starts_at: new Date(clock.getTime() + 60 * 60_000),
      unit: 'Unidade teste',
      status: 'cancelled',
      version: 1,
      created_by: manager.id,
    };
    if (db.kind === 'mongo') await db.insert('appointments', cancelledAppointment);
    else
      await db.query(
        'INSERT INTO appointments(id,opportunity_id,starts_at,unit,status,version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        Object.values(cancelledAppointment),
      );
    const agenda = await app.inject({
      url: `/api/v1/appointments?from=${encodeURIComponent(new Date(clock.getTime() + 30 * 60_000).toISOString())}&to=${encodeURIComponent(new Date(clock.getTime() + 90 * 60_000).toISOString())}`,
      headers: headers.get(manager.id),
    });
    assert.equal(agenda.statusCode, 200, agenda.body);
    assert.equal(
      agenda.json().items.some((item: { id: string }) => item.id === cancelledAppointment.id),
      false,
    );
    const count = (await all('opportunities')).length;
    await receive('quality-later');
    await comment('99000000000000002');
    assert.equal((await all('opportunities')).length, count);
    assert.equal(
      (await central.comments.list(consultant)).comments.some(
        (row) => row.sender_id === '88100000000000123',
      ),
      false,
    );
    assert.equal((await central.list(consultant, 'mine')).conversations.length, 0);
    const archived = (await central.list(consultant, 'non_commercial')).conversations[0];
    assert.equal(archived.unread, false);
    assert.equal(archived.can_send, true);
    assert.equal(archived.notifications_muted, true);
    const thread = await central.messages(consultant, String(conversation.id));
    assert.equal(thread.messages.length, 3);
    assert.equal(thread.can_send, true);
    const sent = await central.send(consultant, String(conversation.id), 'Olá', randomUUID());
    assert.equal(sent.status, 'sent');
    await assert.rejects(
      central.setNotificationsMuted(consultant, String(conversation.id), false),
      /não comercial/,
    );
    assert.equal(
      (await all('push_records')).some(
        (row) =>
          row.data?.opportunityId === incoming.id ||
          row.data?.event?.data?.opportunityId === incoming.id,
      ),
      false,
    );
    assert.equal((await qualityDetails(db, afterMark, consultant)).compensation_status, 'pending');
    assert.equal((await crm.detail(consultant, incoming.id)).can_edit, false);
    if (db.kind === 'mongo') {
      await initializeMongo(db);
      assert.equal((await lead(incoming.id)).non_commercial_reason, 'NON_COMMERCIAL_MENTION');
      assert.equal(
        (await qualityDetails(db, await lead(incoming.id), consultant)).compensation_status,
        'pending',
      );
    }
    // A pending compensation can be revoked; stale requests cannot reapply the classification.
    assert.equal((await mark(manager, afterMark, null)).statusCode, 200);
    assert.equal((await mark(consultant, beforeMark, 'NON_COMMERCIAL_MENTION')).statusCode, 409);
    assert.equal(
      (await qualityDetails(db, await lead(incoming.id), consultant)).compensation_status,
      'revoked',
    );
    assert.equal((await central.list(consultant, 'mine')).conversations.length, 1);
    assert.equal((await mark(consultant, await lead(incoming.id), 'JOB_SEEKER')).statusCode, 200);
    assert.equal(
      (await qualityDetails(db, await lead(incoming.id), consultant)).compensation_status,
      'revoked',
    );

    // Pending credits survive queue configuration and are consumed by pending-lead reconciliation.
    const fresh = await create();
    const freshRow = await lead(fresh.id);
    const beneficiary = users.find((user) => user.id === freshRow.reserved_to)!;
    await crm.claim(beneficiary, fresh.id, 'reservation', freshRow.version, randomUUID());
    assert.equal((await mark(beneficiary, await lead(fresh.id))).statusCode, 200);
    let settings = (await all('distribution_settings'))[0];
    await crm.configure(manager, {
      version: settings.version,
      timeout_minutes: 10,
      participants: users.map((user) => ({ id: user.id, enabled: false, weight: 1 })),
    });
    const pending = await create();
    assert.equal((await lead(pending.id)).state, 'PENDING');
    settings = (await all('distribution_settings'))[0];
    await crm.configure(manager, {
      version: settings.version,
      timeout_minutes: 10,
      participants: users.map((user) => ({ id: user.id, enabled: true, weight: 1 })),
    });
    assert.equal((await lead(pending.id)).reserved_to, beneficiary.id);
    assert.equal((await lead(pending.id)).reservation_origin, 'compensation');
    assert.equal((await all('distribution_settings'))[0].last_position, settings.last_position);
    assert.equal(
      (await qualityDetails(db, await lead(fresh.id), beneficiary)).compensation_status,
      'used',
    );

    // A compensation must not reset or consume consecutive weighted turns.
    await change('distribution_settings', 1, { last_position: 0 });
    for (const user of users)
      await change('users', user.id, {
        queue_weight: user.id === users[0].id ? 3 : 1,
        queue_credit: 0,
      });
    const weighted = await create();
    await crm.claim(users[0], weighted.id, 'reservation', 1, randomUUID());
    assert.equal((await mark(users[0], await lead(weighted.id))).statusCode, 200);
    const creditsBefore = (await all('users')).map((row) => [row.id, row.queue_credit]);
    const weightedReplacement = await create();
    assert.equal((await lead(weightedReplacement.id)).reserved_to, users[0].id);
    assert.deepEqual(
      (await all('users')).map((row) => [row.id, row.queue_credit]),
      creditsBefore,
    );
    const weightedNormal = await create();
    assert.equal((await lead(weightedNormal.id)).reserved_to, users[0].id);
    assert.equal((await all('users')).find((row) => row.id === users[0].id)!.queue_credit, 1);

    // An administrative transfer, including a transfer back, is not a fresh rotation acceptance.
    const transferable = await create();
    await crm.claim(users[0], transferable.id, 'reservation', 1, randomUUID());
    await crm.transfer(
      manager,
      transferable.id,
      { target_id: users[1].id, reason: 'Teste de transferência', expected_version: 2 },
      randomUUID(),
    );
    await crm.transfer(
      manager,
      transferable.id,
      { target_id: users[0].id, reason: 'Retorno de teste', expected_version: 3 },
      randomUUID(),
    );
    const transferredMark = await mark(users[0], await lead(transferable.id));
    assert.equal(transferredMark.statusCode, 200, transferredMark.body);
    assert.equal(transferredMark.json().compensation_status, null);

    // Comments captured directly from the comment pool can be classified without compensation.
    await comment('99000000000000003', '88100000000000456');
    const pooledComment = (await central.comments.list(users[0])).comments.find(
      (row) => row.sender_id === '88100000000000456',
    )!;
    assert.ok(pooledComment);
    const claimedComment = await central.comments.claim(
      users[0],
      String(pooledComment.id),
      Number(pooledComment.version),
    );
    const commentMarked = await mark(
      users[0],
      await lead(String(claimedComment.opportunity_id)),
      'JOB_SEEKER',
    );
    assert.equal(commentMarked.statusCode, 200, commentMarked.body);
    assert.equal(commentMarked.json().compensation_status, null);
    if (db.kind === 'mongo') {
      await initializeMongo(db);
      assert.equal(
        (await lead(String(claimedComment.opportunity_id))).non_commercial_reason,
        'JOB_SEEKER',
      );
    }

    // Every pending replacement is represented in the real delivery order shown to management.
    await change('distribution_settings', 1, { last_position: 0 });
    for (const [index, user] of users.entries())
      await change('users', user.id, {
        active: true,
        queue_enabled: true,
        queue_position: index + 1,
        queue_weight: 1,
        queue_credit: 0,
      });
    const pendingCredits = [
      {
        source_opportunity_id: transferable.id,
        user_id: users[0].id,
        status: 'pending',
        created_at: new Date(clock.getTime() + 1),
        used_at: null,
        replacement_opportunity_id: null,
      },
      {
        source_opportunity_id: String(claimedComment.opportunity_id),
        user_id: users[0].id,
        status: 'pending',
        created_at: new Date(clock.getTime() + 2),
        used_at: null,
        replacement_opportunity_id: null,
      },
    ];
    if (db.kind === 'mongo') {
      for (const credit of pendingCredits) await db.insert('lead_compensations', credit);
    } else {
      for (const credit of pendingCredits)
        await db.query(
          'INSERT INTO lead_compensations(source_opportunity_id,user_id,status,created_at,used_at,replacement_opportunity_id) VALUES($1,$2,$3,$4,$5,$6)',
          Object.values(credit),
        );
    }
    const boardResponse = await app.inject({
      url: '/api/v1/distribution/board',
      headers: headers.get(manager.id),
    });
    assert.equal(boardResponse.statusCode, 200, boardResponse.body);
    const board = boardResponse.json();
    assert.equal(
      board.attendants.find((user: { id: string; queue_rank: number }) => user.id === users[0].id)
        .queue_rank,
      1,
    );
    assert.equal(
      board.attendants.find((user: { id: string; queue_rank: number }) => user.id === users[1].id)
        .queue_rank,
      4,
    );

    // Deactivating an account revokes replacements that can no longer be delivered.
    const currentTarget = (await all('users')).find((user) => user.id === users[0].id)!;
    const deactivated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${users[0].id}`,
      headers: { ...headers.get(manager.id), 'idempotency-key': randomUUID() },
      payload: {
        name: currentTarget.name,
        active: false,
        expected_version: currentTarget.version,
        replacement_id: users[1].id,
        reason: 'Teste de cancelamento de reposição pendente',
      },
    });
    assert.equal(deactivated.statusCode, 200, deactivated.body);
    const revoked = (await all('lead_compensations')).filter(
      (credit) => credit.user_id === users[0].id && credit.status === 'revoked',
    );
    assert.ok(
      pendingCredits.every((pendingCredit) =>
        revoked.some(
          (credit) => credit.source_opportunity_id === pendingCredit.source_opportunity_id,
        ),
      ),
    );
    assert.equal(
      (await all('lead_compensations')).some(
        (credit) => credit.user_id === users[0].id && credit.status === 'pending',
      ),
      false,
    );
    assert.equal((await lead(transferable.id)).owner_id, users[1].id);
    assert.equal(
      (await qualityDetails(db, await lead(transferable.id), users[0])).compensation_status,
      'revoked',
    );
  } finally {
    await app.close();
  }
}
