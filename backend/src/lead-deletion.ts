import { createHash } from 'node:crypto';
import type { Sql } from './db.js';
import { MongoTx } from './mongo-store.js';
import { DomainError, type User, type Opportunity } from './types.js';

export type DeleteLeadInput = { expected_version: number; confirmation: string };
export const eventHash = (id: string) => createHash('sha256').update(id).digest('hex');

// A hash of the delivery ID only: no contact, phone, lead ID or message content.
// Prevents an old delivery/retry from recreating an intentionally deleted lead.
export async function wasDeleted(tx: Sql | MongoTx, externalId: string) {
  const hash = eventHash(externalId);
  return tx instanceof MongoTx
    ? !!(await tx.one('deleted_inbound_events', { hash }))
    : !!(await tx.query('SELECT hash FROM deleted_inbound_events WHERE hash=$1', [hash])).rows
        .length;
}

// Caller holds the queue write fence and revalidates the actor in this transaction.
export async function deleteLeadData(
  tx: Sql | MongoTx,
  actor: User,
  id: string,
  input: DeleteLeadInput,
) {
  if (input.confirmation !== 'EXCLUIR')
    throw new DomainError(
      'CONFIRMATION_REQUIRED',
      'Digite EXCLUIR para confirmar a exclusão permanente.',
      400,
    );
  const mongo = tx instanceof MongoTx;
  const row = mongo
    ? await tx.one<Opportunity>('opportunities', { id })
    : (await tx.query<Opportunity>('SELECT * FROM opportunities WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
  if (!row) throw new DomainError('NOT_FOUND', 'Lead não encontrado.', 404);
  if (actor.role !== 'manager' && row.owner_id !== actor.id)
    throw new DomainError(
      'FORBIDDEN',
      'Você só pode excluir leads que assumiu e continuam sob sua responsabilidade.',
      403,
    );
  if (row.version !== input.expected_version)
    throw new DomainError(
      'VERSION_CONFLICT',
      'O lead mudou. Feche e reabra a ficha antes de excluir.',
    );

  if (mongo) {
    const contact = await tx.one('contacts', { id: row.contact_id });
    const shared = await tx.count('opportunities', { contact_id: row.contact_id, id: { $ne: id } });
    const events = await tx.many('inbound_events', { opportunity_id: id });
    const inboxFilter = {
      $or: [
        { opportunity_id: id },
        { event_id: { $in: events.map((e) => e.external_id) } },
        ...(!shared && contact ? [{ 'lead.phone': contact.phone }] : []),
      ],
    };
    const inbox = await tx.many('whatsapp_inbox', inboxFilter);
    for (const externalId of new Set([
      ...events.map((e) => e.external_id),
      ...inbox.map((e) => e.event_id),
    ]))
      await tx
        .collection('deleted_inbound_events')
        .updateOne(
          { hash: eventHash(externalId) },
          { $setOnInsert: { hash: eventHash(externalId) } },
          { upsert: true, session: tx.session },
        );
    const appointments = await tx.many('appointments', { opportunity_id: id });
    await tx.remove('push_records', {
      kind: { $in: ['event', 'job'] },
      $or: [{ 'data.opportunityId': id }, { 'data.event.data.opportunityId': id }],
    });
    await tx.remove('claims', { 'response.id': id });
    await tx.remove('operation_receipts', {
      'response.id': { $in: [id, ...appointments.map((a) => a.id)] },
    });
    await tx.remove('whatsapp_inbox', inboxFilter);
    for (const collection of ['appointments', 'audit_events', 'inbound_events'])
      await tx.remove(collection, { opportunity_id: id });
    await tx.remove('opportunities', { id });
    if (!shared) await tx.remove('contacts', { id: row.contact_id });
  } else {
    const contact = (
      await tx.query<{ phone: string }>('SELECT phone FROM contacts WHERE id=$1', [row.contact_id])
    ).rows[0];
    const shared = (
      await tx.query('SELECT id FROM opportunities WHERE contact_id=$1 AND id<>$2', [
        row.contact_id,
        id,
      ])
    ).rows.length;
    const events = (
      await tx.query<{ external_id: string }>(
        'SELECT external_id FROM inbound_events WHERE opportunity_id=$1',
        [id],
      )
    ).rows;
    const inbox = (
      await tx.query<{ event_id: string }>(
        `SELECT event_id FROM whatsapp_inbox WHERE opportunity_id=$1 OR event_id=ANY($2::text[])
       OR ($3::boolean AND lead->>'phone'=$4) FOR UPDATE`,
        [id, events.map((e) => e.external_id), !shared, contact?.phone ?? ''],
      )
    ).rows;
    for (const externalId of new Set([
      ...events.map((e) => e.external_id),
      ...inbox.map((e) => e.event_id),
    ]))
      await tx.query('INSERT INTO deleted_inbound_events(hash) VALUES($1) ON CONFLICT DO NOTHING', [
        eventHash(externalId),
      ]);
    await tx.query(
      `DELETE FROM push_records WHERE kind IN ('event','job') AND
      (data->>'opportunityId'=$1 OR data->'event'->'data'->>'opportunityId'=$1)`,
      [id],
    );
    await tx.query("DELETE FROM claims WHERE response->>'id'=$1", [id]);
    await tx.query(
      `DELETE FROM operation_receipts WHERE response->>'id'=$1 OR response->>'id' IN
      (SELECT id::text FROM appointments WHERE opportunity_id=$1::uuid)`,
      [id],
    );
    await tx.query('DELETE FROM whatsapp_inbox WHERE event_id=ANY($1::text[])', [
      inbox.map((e) => e.event_id),
    ]);
    await tx.query('DELETE FROM appointments WHERE opportunity_id=$1', [id]);
    await tx.query('DELETE FROM audit_events WHERE opportunity_id=$1', [id]);
    await tx.query('DELETE FROM inbound_events WHERE opportunity_id=$1', [id]);
    await tx.query('DELETE FROM opportunities WHERE id=$1', [id]);
    if (!shared) await tx.query('DELETE FROM contacts WHERE id=$1', [row.contact_id]);
  }
  return { deleted: true };
}
