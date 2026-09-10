import { randomUUID } from 'node:crypto';
import { CRM } from './crm.js';
import { hashPassword } from './auth.js';
import type { User } from './types.js';

export const DEMO_PASSWORD = 'Artisti.demo2026!';
export async function seedDemo(crm: CRM, withLeads = true) {
  const count = (await crm.db.query<{ count: string }>('SELECT count(*) FROM users')).rows[0];
  if (Number(count.count)) return;
  const hash = await hashPassword(DEMO_PASSWORD);
  const profiles = [
    ['Cadu', 'cadu', 'manager', '#EDB25A'],
    ['Vanessa', 'vanessa', 'attendant', '#D8B986'],
    ['Priscila', 'priscila', 'attendant', '#8DC4BA'],
    ['Vitória', 'vitoria', 'attendant', '#B4ADDB'],
    ['Calel', 'calel', 'attendant', '#93B9DF'],
  ];
  await crm.db.transaction(async (tx) => {
    for (let i = 0; i < profiles.length; i++) {
      const [name, slug, role, color] = profiles[i];
      await tx.query(
        'INSERT INTO users(id,name,email,password_hash,role,queue_enabled,queue_position,color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [randomUUID(), name, `${slug}@demo.artisti.local`, hash, role, i > 0, i || null, color],
      );
    }
  });
  if (!withLeads) return;
  const users = (await crm.db.query<User>('SELECT * FROM users')).rows;
  const names = [
    'Rafael Almeida',
    'Lucas Martins',
    'Gustavo Pereira',
    'André Costa',
    'Felipe Souza',
    'Bruno Oliveira',
    'Ricardo Lima',
    'Thiago Santos',
    'Daniel Rocha',
    'Marcelo Nunes',
    'Eduardo Ribeiro',
    'Henrique Alves',
  ];
  for (let i = 0; i < names.length; i++) {
    const created = await crm.ingest(
      {
        name: names[i],
        phone: `550000000${String(1000 + i)}`,
        interest: i % 4 === 0 ? 'Avaliação capilar' : 'Transplante capilar',
        unit: 'Unidade de demonstração',
        source: ['Google Ads', 'Meta Ads', 'Não identificada'][i % 3],
        is_demo: true,
      },
      `seed-${i}`,
      null,
    );
    const row = (
      await crm.db.query<{ reserved_to: string; version: number }>(
        'SELECT reserved_to,version FROM opportunities WHERE id=$1',
        [created.id],
      )
    ).rows[0];
    if (i < 8) {
      await crm.claim(
        users.find((u) => u.id === row.reserved_to)!,
        created.id,
        'reservation',
        row.version,
        `seed-claim-${i}`,
      );
      const stage = ['TO_QUALIFY', 'EVALUATION_SCHEDULED', 'NEGOTIATION', 'CONTRACT_PENDING'][
        i % 4
      ];
      await crm.db.query(
        'UPDATE opportunities SET stage=$2,next_action=$3,created_at=$4 WHERE id=$1',
        [
          created.id,
          stage,
          [
            'Confirmar melhor horário para contato',
            'Lembrar avaliação agendada',
            'Retornar sobre proposta',
            'Aguardar documentação',
          ][i % 4],
          new Date(Date.now() - (i + 1) * 3_600_000),
        ],
      );
      if (i % 4 === 1) {
        const starts = new Date();
        starts.setDate(starts.getDate() + 1);
        starts.setHours(10 + i, 0, 0, 0);
        await crm.db.query(
          'INSERT INTO appointments(id,opportunity_id,starts_at,unit,created_by) VALUES ($1,$2,$3,$4,$5)',
          [randomUUID(), created.id, starts, 'Unidade de demonstração', row.reserved_to],
        );
      }
    } else if (i < 10) {
      await crm.db.query('UPDATE opportunities SET expires_at=$2 WHERE id=$1', [
        created.id,
        new Date(Date.now() - 60_000),
      ]);
    }
  }
  await crm.expire();
}
