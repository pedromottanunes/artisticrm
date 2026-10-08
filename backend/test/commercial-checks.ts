import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';
import { tokenHash } from '../src/auth.js';
import { migrate, type Database } from '../src/db.js';
import { initializeMongo, type MongoStore } from '../src/mongo-store.js';
import type { User } from '../src/types.js';

export async function checkCommercialDrafts(
  db: Database | MongoStore,
  manager: User,
  users: User[],
) {
  const { app, crm } = await buildApp(db, { reconcile: false });
  const headersFor = async (user: User) => {
    const token = randomUUID();
    const session = {
      token_hash: tokenHash(token),
      user_id: user.id,
      auth_version: user.auth_version,
      expires_at: new Date(Date.now() + 3600_000),
    };
    if (db.kind === 'mongo') await db.insert('sessions', session);
    else
      await db.query(
        'INSERT INTO sessions(token_hash,user_id,auth_version,expires_at) VALUES($1,$2,$3,$4)',
        Object.values(session),
      );
    return { cookie: `artisti_session=${token}`, 'x-artisti-client': 'web' };
  };
  try {
    const owner = await headersFor(users[0]),
      other = await headersFor(users[1]),
      master = await headersFor(manager);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/opportunities',
      headers: { ...owner, 'idempotency-key': randomUUID() },
      payload: {
        name: 'Paciente teste',
        phone: '5548991234588',
        unit: 'Unidade teste',
        source: 'Indicação',
      },
    });
    assert.equal(created.statusCode, 201, created.body);
    const id = created.json().id;
    const url = `/api/v1/opportunities/${id}`;
    const detail = async () => {
      const response = await app.inject({ url, headers: owner });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const patch = (payload: object, headers = owner) =>
      app.inject({ method: 'PATCH', url, headers, payload });
    const original = await detail();
    const base = {
      version: original.version,
      name: 'Paciente editado',
      phone: '5548991234588',
      residence_city: 'Bonito',
      instagram: '',
      interest: 'Avaliação',
      unit: 'Florianópolis',
      stage: 'FOLLOW_UP',
      procedure_date: '2027-11-09',
      next_action: 'Retornar amanhã',
    };
    const commercial = {
      sale_seller_name: 'Vendedor escolhido',
      consultant: 'Consultor escolhido',
      total_value_cents: 1650000,
      down_payment_cents: 150000,
      total_value_text: 'R$ 16.500,00',
      down_payment_text: 'R$ 1.500,00',
      hair_grade_classification: 'A3',
      has_pack: true,
      pack_quantity: 3,
      contract_status: 'awaiting',
    };
    const full = { ...base, ...commercial };
    const saved = await patch(full);
    assert.equal(saved.statusCode, 200, saved.body);
    let lead = await detail();
    for (const [field, value] of Object.entries(full))
      if (field !== 'version')
        assert.equal(
          field === 'procedure_date' ? lead[field]?.slice(0, 10) : lead[field],
          value,
          field,
        );
    assert.equal(lead.sale_completed_at, null, 'saving a complete draft is not a sale');
    assert.equal(lead.state, 'CLAIMED');
    assert.equal(lead.owner_id, users[0].id);
    assert.equal((await patch(full)).statusCode, 409, 'stale edits must not overwrite');
    assert.equal((await patch({ ...full, version: lead.version }, other)).statusCode, 404);
    for (const invalid of [
      { pack_quantity: -1 },
      { pack_quantity: 1.5 },
      { total_value_cents: -1 },
    ]) {
      assert.equal((await patch({ ...full, version: lead.version, ...invalid })).statusCode, 400);
      assert.equal((await detail()).version, lead.version, 'invalid saves must be atomic');
    }
    // Older clients omit commercial fields: those values must survive too.
    assert.equal((await patch({ ...base, version: lead.version })).statusCode, 200);
    lead = await detail();
    for (const [field, value] of Object.entries(commercial))
      assert.equal(lead[field], value, field);
    // Status is editable; even a "closed" commercial stage does not end attendance.
    assert.equal(
      (await patch({ ...full, version: lead.version, stage: 'CLOSED_WITH_DATE' }, master))
        .statusCode,
      200,
    );
    lead = await detail();
    if (db.kind === 'mongo') await initializeMongo(db);
    else await migrate(db);
    assert.equal(
      (await detail()).sale_completed_at,
      null,
      'restart must not turn drafts into sales',
    );
    assert.equal((await detail()).state, 'CLAIMED');
    const sale = {
      ...commercial,
      expected_version: lead.version,
      name: base.name,
      phone: base.phone,
      residence_city: base.residence_city,
      unit: base.unit,
      procedure_date: base.procedure_date,
      sale_seller_name: 'Outro nome livre',
      // "No pack" is authoritative even if an external client sends a
      // contradictory quantity. Both stores must persist a consistent pair.
      has_pack: false,
      pack_quantity: 3,
      total_value_cents: null,
      down_payment_cents: null,
      total_value_text: 'Valor combinado diretamente com o paciente',
      down_payment_text: 'Entrada parcelada em 3 vezes',
    };
    const saleKey = randomUUID();
    const sendSale = () =>
      app.inject({
        method: 'PUT',
        url: `${url}/sale`,
        headers: { ...owner, 'idempotency-key': saleKey },
        payload: sale,
      });
    const registered = await sendSale();
    assert.equal(registered.statusCode, 200, registered.body);
    assert.equal((await sendSale()).statusCode, 200, 'retry cannot duplicate sale');
    lead = await detail();
    assert.ok(lead.sale_completed_at);
    assert.equal(lead.sale_seller_name, 'Outro nome livre');
    assert.equal(lead.has_pack, false);
    assert.equal(lead.pack_quantity, 0);
    assert.equal(lead.total_value_cents, null);
    assert.equal(lead.down_payment_cents, null);
    assert.equal(lead.total_value_text, 'Valor combinado diretamente com o paciente');
    assert.equal(lead.down_payment_text, 'Entrada parcelada em 3 vezes');
    assert.equal(lead.owner_id, users[0].id);
    assert.equal(lead.state, 'CLAIMED');
    const received = await crm.ingest(
      { name: base.name, phone: base.phone, interest: '', unit: '', source: 'Orgânica' },
      randomUUID(),
      null,
    );
    assert.equal(received.id, id, 'new inbound must remain with the same lead and consultant');
    lead = await detail();
    const timestamp = lead.sale_completed_at;
    // Explicitly clearing draft values persists; no closing or implicit sale is triggered.
    const cleared = await patch({
      ...full,
      version: lead.version,
      stage: 'FOLLOW_UP',
      procedure_date: null,
      total_value_cents: null,
      down_payment_cents: null,
      total_value_text: '',
      down_payment_text: '',
      has_pack: false,
      pack_quantity: 0,
      sale_seller_name: '',
      consultant: '',
      hair_grade_classification: '',
    });
    assert.equal(cleared.statusCode, 200, cleared.body);
    lead = await detail();
    assert.equal(lead.total_value_cents, null);
    assert.equal(lead.down_payment_cents, null);
    assert.equal(lead.total_value_text, '');
    assert.equal(lead.down_payment_text, '');
    assert.equal(lead.sale_seller_name, '');
    assert.equal(lead.pack_quantity, 0);
    assert.equal(lead.procedure_date, null);
    assert.equal(lead.sale_completed_at, timestamp);
    assert.equal(lead.state, 'CLAIMED');
    if (db.kind === 'mongo') await initializeMongo(db);
    else await migrate(db);
    assert.equal(
      (await detail()).version,
      lead.version,
      'restart preserves saved fields and versions',
    );
  } finally {
    await app.close();
  }
}

export async function checkCommercialMigration(
  db: Database | MongoStore,
  manager: User,
  users: User[],
) {
  const { app, crm } = await buildApp(db, { reconcile: false });
  const set = async (id: string, values: Record<string, unknown>) => {
    if (db.kind === 'mongo') await db.update('opportunities', { id }, { $set: values });
    else
      await db.query(
        `UPDATE opportunities SET ${Object.keys(values)
          .map((key, i) => `${key}=$${i + 2}`)
          .join(',')} WHERE id=$1`,
        [id, ...Object.values(values)],
      );
  };
  const get = async (id: string) =>
    db.kind === 'mongo'
      ? db.one('opportunities', { id })
      : (await db.query('SELECT * FROM opportunities WHERE id=$1', [id])).rows[0];
  const input = (n: number) => ({
    name: 'Cadastro legado',
    phone: `554899123459${n}`,
    interest: '',
    unit: 'Teste',
    source: 'Cadastro manual',
  });
  try {
    const single = await crm.ingest(input(1), randomUUID(), manager.id);
    const historical = await crm.ingest(input(2), randomUUID(), manager.id);
    const unowned = await crm.ingest(input(3), randomUUID(), manager.id);
    for (const id of [single.id, historical.id, unowned.id])
      await set(id, {
        state: 'CANCELLED',
        stage: 'CLOSED_WITHOUT_DATE',
        reserved_to: null,
        expires_at: null,
        owner_id: id === unowned.id ? null : users[0].id,
        sale_seller_name: 'Vendedor original',
        total_value_cents: 123400,
        created_at: new Date('2020-01-01T00:00:00Z'),
        ...(db.kind === 'mongo' ? { open: false } : {}),
      });
    const current = await crm.ingest(input(2), randomUUID(), manager.id);
    await crm.transfer(
      manager,
      current.id,
      { expected_version: 1, target_id: users[1].id, reason: 'Atendimento mais recente' },
      randomUUID(),
    );
    if (db.kind === 'mongo') {
      await db.remove('schema_migrations', { id: '035_commercial_drafts' });
      await initializeMongo(db);
    } else {
      // Restore only the pre-035 schema in this isolated test database.
      await db.query('ALTER TABLE opportunities DROP COLUMN pack_quantity');
      await db.query('DROP INDEX one_active_opportunity');
      await db.query(
        "CREATE UNIQUE INDEX one_active_opportunity ON opportunities(contact_id) WHERE stage NOT IN ('CONTRACT_PENDING','CLOSED_WITH_DATE','CLOSED_WITHOUT_DATE','DECLINED')",
      );
      await db.query("DELETE FROM schema_migrations WHERE version='035'");
      await migrate(db);
    }
    const recovered = (await get(single.id))!;
    assert.equal(recovered.state, 'CLAIMED');
    assert.equal(recovered.owner_id, users[0].id);
    assert.equal(recovered.sale_seller_name, 'Vendedor original');
    assert.equal(recovered.total_value_cents, 123400);
    assert.equal(recovered.sale_completed_at, null, 'migration must not invent a sale');
    assert.equal(
      (await get(historical.id))!.state,
      'CANCELLED',
      'do not reopen a duplicate historical record',
    );
    assert.equal((await get(current.id))!.owner_id, users[1].id, 'preserve the current consultant');
    assert.equal(
      (await get(unowned.id))!.state,
      'CANCELLED',
      'never automatically distribute an old unowned record',
    );
    if (db.kind === 'mongo') await initializeMongo(db);
    else await migrate(db);
    assert.deepEqual(
      await get(single.id),
      recovered,
      'migration is one-time and preserves saved values',
    );
  } finally {
    await app.close();
  }
}
