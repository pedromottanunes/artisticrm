import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { agendaPage, agendaQuery } from '../src/agenda.js';
import type { Operations } from '../src/operations.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';

export async function checkAgenda(crm: Operations | MongoOperations, manager: User, users: User[]) {
  const db = crm.db;
  const from = '2026-10-01T00:00:00.000Z',
    to = '2026-11-01T00:00:00.000Z';
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const lead = await crm.ingest(
      {
        name: `Agenda ${index}`,
        phone: `554899994000${index}`,
        interest: 'Teste',
        unit: 'Teste',
        source: 'Manual',
      },
      `agenda-${index}`,
      manager.id,
    );
    ids.push(lead.id);
    if (db.kind === 'mongo')
      await db.update(
        'opportunities',
        { id: lead.id },
        { $set: { owner_id: users[index].id, state: 'CLAIMED' } },
      );
    else
      await db.query("UPDATE opportunities SET owner_id=$2,state='CLAIMED' WHERE id=$1", [
        lead.id,
        users[index].id,
      ]);
  }
  const items = Array.from({ length: 107 }, (_, i) => ({
    id: randomUUID(),
    opportunity_id: ids[i === 106 ? 1 : 0],
    starts_at: new Date(i === 105 ? '2026-11-01T00:00:00Z' : '2026-10-15T12:00:00Z'),
    unit: 'Unidade teste',
    status: 'attended',
    version: 1,
    created_by: manager.id,
  }));
  if (db.kind === 'mongo') await db.collection('appointments').insertMany(items);
  else
    for (const row of items)
      await db.query(
        'INSERT INTO appointments(id,opportunity_id,starts_at,unit,status,version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        Object.values(row),
      );
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await agendaPage(
      db,
      users[0],
      agendaQuery.parse({ from, to, cursor: cursor ?? undefined }),
    );
    assert.ok(page.items.length <= 50);
    assert.ok(page.items.every((item) => item.owner_id === users[0].id));
    seen.push(...page.items.map((item) => item.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.equal(seen.length, 105);
  assert.equal(new Set(seen).size, 105, 'ties on date do not duplicate or skip appointments');
  const other = await agendaPage(db, users[1], agendaQuery.parse({ from, to }));
  assert.equal(other.items.length, 1);
  const all = await agendaPage(db, manager, agendaQuery.parse({ from, to }));
  assert.equal(all.items.length, 50);
  assert.ok(all.next_cursor);
  assert.throws(() => agendaQuery.parse({ from, to: '2027-12-01T00:00:00Z' }));
  assert.throws(() => agendaQuery.parse({ from, to, cursor: 'invalid-cursor' }));
  assert.equal((await crm.snapshot(manager, false)).appointments.length, 0);
  assert.equal((await crm.snapshot(manager)).appointments.length, 100);
}
