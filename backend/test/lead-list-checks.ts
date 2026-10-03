import assert from 'node:assert/strict';
import type { CRM } from '../src/crm.js';
import { leadListsPage, type LeadListCategory } from '../src/lead-lists.js';
import type { MongoOperations } from '../src/mongo-crm.js';
import type { User } from '../src/types.js';

const query = (
  category: LeadListCategory,
  overrides: Partial<{ owner: string; search: string; page: number }> = {},
) => ({ category, owner: '', search: '', page: 1, ...overrides });

export async function checkLeadLists(
  crm: CRM | MongoOperations,
  manager: User,
  attendants: User[],
) {
  const fixtures = [
    ['Ana Agendada', 'SCHEDULED', 'FOLLOW_UP', null, attendants[0].id],
    ['Bruna Compareceu', 'ATTENDED', 'FOLLOW_UP', null, attendants[0].id],
    ['Carla Faltou', 'NO_SHOW', 'DECLINED', null, attendants[0].id],
    ['Dora Contrato', 'NOT_SCHEDULED', 'CONTRACT_PENDING', 'awaiting', attendants[1].id],
    ['Eva Fechada', 'ATTENDED', 'CLOSED_WITH_DATE', 'signed', attendants[0].id],
  ] as const;
  for (const [index, [name, consultation, stage, contract, owner]] of fixtures.entries()) {
    const created = await crm.ingest(
      {
        name,
        phone: `55489999000${index}`,
        interest: 'Avaliação',
        unit: 'Teste',
        source: 'Cadastro manual',
      },
      `lead-list-${index}`,
      manager.id,
    );
    if (crm.db.kind === 'mongo')
      await crm.db.update(
        'opportunities',
        { id: created.id },
        {
          $set: {
            owner_id: owner,
            reserved_to: null,
            state: 'CLAIMED',
            consultation_status: consultation,
            stage,
            contract_status: contract,
          },
        },
      );
    else
      await crm.db.query(
        `UPDATE opportunities SET owner_id=$2,reserved_to=NULL,state='CLAIMED',
           consultation_status=$3,stage=$4,contract_status=$5 WHERE id=$1`,
        [created.id, owner, consultation, stage, contract],
      );
  }

  const managerAll = await leadListsPage(crm.db, manager, query('ALL'));
  assert.equal(managerAll.total, 5);
  assert.equal(managerAll.counts.ATTENDED, 2);
  assert.equal(managerAll.counts.CONTRACT_PENDING, 1);
  assert.equal(managerAll.counts.CLOSED, 1);

  const own = await leadListsPage(crm.db, attendants[0], query('ALL'));
  assert.equal(own.total, 4);
  assert.ok(own.rows.every((row) => row.owner_id === attendants[0].id));
  assert.equal('phone' in own.rows[0], false, 'list rows should not expose unused contact data');
  const forgedOwner = await leadListsPage(
    crm.db,
    attendants[0],
    query('ALL', { owner: attendants[1].id }),
  );
  assert.equal(forgedOwner.total, 4, 'an attendant cannot select another owner');
  assert.ok(forgedOwner.rows.every((row) => row.owner_id === attendants[0].id));

  const secondAttendant = await leadListsPage(
    crm.db,
    manager,
    query('ALL', { owner: attendants[1].id }),
  );
  assert.equal(secondAttendant.total, 1);
  assert.equal(secondAttendant.rows[0]?.name, 'Dora Contrato');
  assert.equal(
    (await leadListsPage(crm.db, manager, query('NO_SHOW'))).rows[0]?.name,
    'Carla Faltou',
  );
  assert.equal(
    (await leadListsPage(crm.db, manager, query('ALL', { search: 'eva' }))).rows[0]?.name,
    'Eva Fechada',
  );
}
