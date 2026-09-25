import {
  MongoClient,
  type ClientSession,
  type Db,
  type Document,
  type Filter,
  type UpdateFilter,
} from 'mongodb';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { hashPassword } from './auth.js';
import { loginSchema, passwordSchema } from './credentials.js';
import { compactQueuePositions } from './weighted-queue.js';

// Native document operations. No SQL emulation and no in-memory source of truth.
export class MongoTx {
  constructor(
    public database: Db,
    public session?: ClientSession,
  ) {}
  collection(name: string) {
    return this.database.collection(name);
  }
  async one<T = Document>(name: string, filter: Filter<Document>): Promise<T | null> {
    return (await this.collection(name).findOne(filter, {
      session: this.session,
      projection: { _id: 0 },
    })) as T | null;
  }
  async many<T = Document>(
    name: string,
    filter: Filter<Document> = {},
    sort: Record<string, 1 | -1> = {},
    limit = 0,
  ): Promise<T[]> {
    return (await this.collection(name)
      .find(filter, { session: this.session, projection: { _id: 0 } })
      .sort(sort)
      .limit(limit)
      .toArray()) as T[];
  }
  async insert(name: string, value: Document) {
    await this.collection(name).insertOne({ ...value }, { session: this.session });
  }
  async update(name: string, filter: Filter<Document>, update: UpdateFilter<Document>) {
    return this.collection(name).updateMany(filter, update, { session: this.session });
  }
  async remove(name: string, filter: Filter<Document>) {
    return this.collection(name).deleteMany(filter, { session: this.session });
  }
  async count(name: string, filter: Filter<Document> = {}) {
    return this.collection(name).countDocuments(filter, { session: this.session });
  }
  async now() {
    const row = await this.collection('distribution_settings')
      .aggregate<{ now: Date }>([{ $match: { id: 1 } }, { $project: { _id: 0, now: '$$NOW' } }], {
        session: this.session,
      })
      .next();
    if (!row) throw new Error('MongoDB has not been initialized');
    return row.now;
  }
}

export class MongoStore extends MongoTx {
  readonly kind = 'mongo' as const;
  constructor(
    public client: MongoClient,
    databaseName: string,
  ) {
    super(client.db(databaseName));
  }
  async atomic<T>(work: (tx: MongoTx) => Promise<T>, readOnly = false): Promise<T> {
    return this.client.withSession(async (session) =>
      session.withTransaction(
        async () => {
          const tx = new MongoTx(this.database, session);
          // Small-team CRM: a database-backed write fence gives a fixed serialization
          // order to queue/claim/account changes. Driver retries write conflicts safely.
          if (!readOnly) {
            const fence = await tx.update(
              'distribution_settings',
              { id: 1 },
              { $inc: { fence: 1 } },
            );
            if (fence.matchedCount !== 1) throw new Error('MongoDB has not been initialized');
          }
          return work(tx);
        },
        {
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
          readPreference: 'primary',
          maxCommitTimeMS: 15_000,
        },
      ),
    );
  }
  async close() {
    await this.client.close();
  }
}

export async function openMongo(uri: string, databaseName = 'artisti') {
  if (!/^mongodb(?:\+srv)?:\/\//.test(uri) || !/^[a-zA-Z0-9_-]{1,63}$/.test(databaseName))
    throw new Error('MONGODB_URI ou MONGODB_DB inválido.');
  let client: MongoClient | undefined;
  try {
    client = new MongoClient(uri, {
      maxPoolSize: 8,
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 10_000,
      retryWrites: true,
    });
    await client.connect();
    const hello = await client.db(databaseName).command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid')
      throw new Error('Transactions require a replica set');
    return new MongoStore(client, databaseName);
  } catch {
    await client?.close();
    // Driver errors may contain hosts/credentials. Never surface the original error.
    throw new Error(
      'Não foi possível conectar ao MongoDB. Verifique URI, permissões e IPs autorizados no Atlas. É necessário replica set/Atlas.',
    );
  }
}

export async function initializeMongo(db: MongoStore) {
  await db.collection('opportunities').updateMany(
    { source: 'Instagram — origem não identificada' },
    { $set: { source: 'Instagram — origem orgânica' } },
  );
  const stageMigration = {
    TO_QUALIFY: 'CONSULTATION_NOT_SCHEDULED',
    EVALUATION_SCHEDULED: 'FOLLOW_UP',
    NEGOTIATION: 'FOLLOW_UP',
    WON: 'CLOSED_WITHOUT_DATE',
    LOST: 'DECLINED',
  } as const;
  const closedStages = ['CONTRACT_PENDING', 'CLOSED_WITH_DATE', 'CLOSED_WITHOUT_DATE', 'DECLINED'];
  for (const [previous, next] of Object.entries(stageMigration)) {
    const closed = closedStages.includes(next);
    await db.collection('opportunities').updateMany(
      { stage: previous },
      {
        $set: {
          stage: next,
          open: !closed,
          ...(closed ? { state: 'CANCELLED', reserved_to: null, expires_at: null } : {}),
        },
      },
    );
  }
  await db.collection('opportunities').updateMany(
    { stage: { $in: closedStages } },
    {
      $set: {
        open: false,
        state: 'CANCELLED',
        reserved_to: null,
        expires_at: null,
      },
    },
  );
  await db
    .collection('opportunities')
    .updateMany({ procedure_date: { $exists: false } }, { $set: { procedure_date: null } });
  await db
    .collection('contacts')
    .updateMany({ residence_city: { $exists: false } }, { $set: { residence_city: '' } });
  await db
    .collection('appointments')
    .updateMany({ status: 'completed' }, { $set: { status: 'attended' } });
  await db
    .collection('opportunities')
    .updateMany(
      { stage: 'CONSULTATION_NOT_SCHEDULED', consultation_status: { $exists: false } },
      { $set: { stage: 'NEW_LEAD', consultation_status: 'UNDEFINED' } },
    );
  await db
    .collection('opportunities')
    .updateMany(
      { consultation_status: { $exists: false } },
      { $set: { consultation_status: 'NOT_SCHEDULED' } },
    );
  const consultationRows = await db
    .collection('appointments')
    .aggregate([
      { $sort: { starts_at: -1, id: -1 } },
      { $group: { _id: '$opportunity_id', status: { $first: '$status' } } },
    ])
    .toArray();
  const consultationStatus = {
    scheduled: 'SCHEDULED',
    attended: 'ATTENDED',
    no_show: 'NO_SHOW',
    cancelled: 'CANCELLED',
  } as const;
  for (const row of consultationRows) {
    const status = consultationStatus[row.status as keyof typeof consultationStatus];
    if (status)
      await db
        .collection('opportunities')
        .updateOne({ id: row._id }, { $set: { consultation_status: status } });
  }
  await db.collection('opportunities').updateMany(
    { sale_completed_at: { $exists: false } },
    {
      $set: {
        sale_completed_at: null,
        sale_seller_name: '',
        consultant: '',
        total_value_cents: null,
        down_payment_cents: null,
        hair_grade_classification: '',
        has_pack: null,
        contract_status: null,
      },
    },
  );
  await db.collection('opportunities').updateMany(
    {
      stage: { $in: ['CONTRACT_PENDING', 'CLOSED_WITH_DATE', 'CLOSED_WITHOUT_DATE'] },
      sale_completed_at: null,
    },
    [
      {
        $set: {
          sale_completed_at: '$created_at',
          contract_status: {
            $cond: [{ $eq: ['$stage', 'CONTRACT_PENDING'] }, 'awaiting', '$contract_status'],
          },
        },
      },
    ],
  );
  const legacyInstagramIds = (
    await db.many<{ opportunity_id: string }>('inbound_events', {
      external_id: { $regex: '^instagram:' },
    })
  ).map((event) => event.opportunity_id);
  const legacyWhatsappIds = (
    await db.many<{ opportunity_id: string }>('inbound_events', {
      external_id: { $regex: '^whatsapp:' },
    })
  ).map((event) => event.opportunity_id);
  if (legacyInstagramIds.length)
    await db
      .collection('opportunities')
      .updateMany(
        { id: { $in: legacyInstagramIds }, channel: { $exists: false } },
        { $set: { channel: 'instagram' } },
      );
  if (legacyWhatsappIds.length)
    await db
      .collection('opportunities')
      .updateMany(
        { id: { $in: legacyWhatsappIds }, channel: { $exists: false } },
        { $set: { channel: 'whatsapp' } },
      );
  await db
    .collection('opportunities')
    .updateMany({ channel: { $exists: false } }, { $set: { channel: 'manual' } });
  await db
    .collection('opportunities')
    .updateMany(
      { channel: 'instagram', interest: '' },
      { $set: { interest: 'Direct do Instagram' } },
    );
  await db
    .collection('users')
    .updateMany({ queue_weight: { $exists: false } }, { $set: { queue_weight: 1 } });
  await db
    .collection('users')
    .updateMany({ queue_credit: { $exists: false } }, { $set: { queue_credit: 0 } });
  for (const name of ['users', 'contacts', 'opportunities', 'appointments', 'audit_events'])
    await db.collection(name).createIndex({ id: 1 }, { unique: true });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db
    .collection('users')
    .createIndex(
      { queue_position: 1 },
      { unique: true, partialFilterExpression: { queue_position: { $type: 'number' } } },
    );
  const currentPhoneIndex = (await db.collection('contacts').listIndexes().toArray()).find(
    (index) => index.name === 'phone_1',
  );
  if (currentPhoneIndex && !currentPhoneIndex.partialFilterExpression)
    await db.collection('contacts').dropIndex('phone_1');
  await db
    .collection('contacts')
    .createIndex(
      { phone: 1 },
      { unique: true, partialFilterExpression: { phone: { $type: 'string' } } },
    );
  await db
    .collection('opportunities')
    .createIndex({ contact_id: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await db.collection('opportunities').createIndex({ state: 1, expires_at: 1 });
  await db.collection('opportunities').createIndex({ owner_id: 1, created_at: -1 });
  await db.collection('opportunities').createIndex({ state: 1, reserved_to: 1 });
  await db.collection('opportunities').createIndex({ created_at: -1 });
  await db.collection('opportunities').createIndex({ stage: 1, created_at: -1 });
  await db.collection('appointments').createIndex({ opportunity_id: 1, status: 1 });
  await db
    .collection('appointments')
    .createIndex(
      { opportunity_id: 1 },
      { unique: true, partialFilterExpression: { status: 'scheduled' } },
    );
  await db.collection('audit_events').createIndex({ opportunity_id: 1, created_at: -1 });
  await db.collection('audit_events').createIndex({ kind: 1, created_at: -1, id: -1 });
  await db.collection('lead_attributions').createIndex({ id: 1 }, { unique: true });
  await db.collection('lead_attributions').createIndex({ external_id: 1 }, { unique: true });
  await db.collection('lead_attributions').createIndex({ opportunity_id: 1, received_at: -1 });
  await db.collection('inbound_events').createIndex({ external_id: 1 }, { unique: true });
  await db.collection('deleted_inbound_events').createIndex({ hash: 1 }, { unique: true });
  await db.collection('claims').createIndex({ user_id: 1, key: 1 }, { unique: true });
  await db.collection('operation_receipts').createIndex({ actor_id: 1, key: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ token_hash: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('whatsapp_inbox').createIndex({ event_id: 1 }, { unique: true });
  await db.collection('channel_accounts').createIndex({ id: 1 }, { unique: true });
  await db
    .collection('channel_accounts')
    .createIndex({ provider: 1, external_account_id: 1 }, { unique: true });
  await db.collection('contact_identities').createIndex({ id: 1 }, { unique: true });
  await db
    .collection('contact_identities')
    .createIndex({ provider: 1, channel_account_id: 1, external_user_id: 1 }, { unique: true });
  await db.collection('contact_identities').createIndex({ contact_id: 1 });
  await db.collection('conversations').createIndex({ id: 1 }, { unique: true });
  await db
    .collection('conversations')
    .createIndex({ channel_account_id: 1, opportunity_id: 1 }, { unique: true });
  await db.collection('conversations').createIndex({ contact_id: 1, last_message_at: -1 });
  await db.collection('messages').createIndex({ id: 1 }, { unique: true });
  await db
    .collection('messages')
    .createIndex(
      { external_message_id: 1 },
      { unique: true, partialFilterExpression: { external_message_id: { $type: 'string' } } },
    );
  await db
    .collection('messages')
    .createIndex(
      { client_request_id: 1 },
      { unique: true, partialFilterExpression: { client_request_id: { $type: 'string' } } },
    );
  await db.collection('messages').createIndex({ conversation_id: 1, created_at: 1, id: 1 });
  await db
    .collection('conversation_reads')
    .createIndex({ conversation_id: 1, user_id: 1 }, { unique: true });
  await db.collection('instagram_webhook_inbox').createIndex({ event_id: 1 }, { unique: true });
  await db
    .collection('instagram_webhook_inbox')
    .createIndex({ instagram_account_id: 1, processed_at: 1, available_at: 1 });
  await db
    .collection('instagram_pending_referrals')
    .createIndex({ account_id: 1, sender_external_id: 1 }, { unique: true });
  await db
    .collection('instagram_pending_referrals')
    .createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('meta_marketing_accounts').createIndex({ account_id: 1 }, { unique: true });
  await db
    .collection('meta_marketing_daily_insights')
    .createIndex({ account_id: 1, date_start: 1, ad_id: 1 }, { unique: true });
  await db
    .collection('meta_marketing_daily_insights')
    .createIndex({ campaign_id: 1, date_start: 1 });
  await db.collection('meta_marketing_sync_state').createIndex({ account_id: 1 }, { unique: true });
  await db.collection('push_records').createIndex({ id: 1 }, { unique: true });
  await db.collection('push_records').createIndex({ kind: 1, available_at: 1 });
  await db.collection('push_records').createIndex({ expires_at: 1 });
  await db
    .collection('whatsapp_inbox')
    .createIndex({ phone_number_id: 1, processed_at: 1, available_at: 1 });
  await db.collection('distribution_settings').createIndex({ id: 1 }, { unique: true });
  await db
    .collection('distribution_settings')
    .updateOne(
      { id: 1 },
      { $setOnInsert: { id: 1, last_position: 0, timeout_minutes: 10, version: 1, fence: 0 } },
      { upsert: true },
    );
  const users = await db.many<{ id: string; queue_position: number | null; version: number }>(
    'users',
    { role: 'attendant' },
    { queue_position: 1, id: 1 },
  );
  const settings = (await db.one<{ last_position: number }>('distribution_settings', {
    id: 1,
  }))!;
  const planned = compactQueuePositions(users, settings.last_position);
  const needsCompaction =
    settings.last_position !== planned.lastPosition ||
    users.some((user) => user.queue_position !== planned.positions.get(user.id));
  if (needsCompaction)
    await db.atomic(async (tx) => {
      const lockedUsers = await tx.many<{
        id: string;
        queue_position: number | null;
        version: number;
      }>('users', { role: 'attendant' }, { queue_position: 1, id: 1 });
      const lockedSettings = (await tx.one<{ last_position: number }>('distribution_settings', {
        id: 1,
      }))!;
      const compacted = compactQueuePositions(lockedUsers, lockedSettings.last_position);
      for (const user of lockedUsers) {
        const queuePosition = compacted.positions.get(user.id)!;
        await tx.update(
          'users',
          { id: user.id },
          {
            $set: { queue_position: queuePosition, queue_credit: 0 },
            ...(user.queue_position === queuePosition ? {} : { $inc: { version: 1 } }),
          },
        );
      }
      await tx.update(
        'distribution_settings',
        { id: 1 },
        {
          $set: { last_position: compacted.lastPosition },
          $inc: { version: 1 },
        },
      );
    });
}

export function mongoUser(input: {
  id?: string;
  name: string;
  email: string;
  password_hash: string;
  role: 'manager' | 'attendant';
  queue_position?: number | null;
  must_change_password?: boolean;
  color?: string;
}) {
  return {
    id: randomUUID(),
    active: true,
    version: 1,
    auth_version: 1,
    queue_enabled: input.role === 'attendant',
    queue_position: null,
    queue_weight: 1,
    queue_credit: 0,
    must_change_password: false,
    color: '#EDB25A',
    ...input,
    email: input.email.toLowerCase(),
  };
}

export async function bootstrapMongo(db: MongoStore, login?: string, password?: string) {
  if (await db.count('users', { email: /@demo\.artisti\.local$/ }))
    throw new Error('Banco contém usuários demo. Use outro banco para homologação.');
  if (await db.count('users')) return;
  const credentials = z
    .object({ login: loginSchema, password: passwordSchema })
    .safeParse({ login, password });
  if (!credentials.success || credentials.data.login.endsWith('@demo.artisti.local'))
    throw new Error('Banco vazio: configure BOOTSTRAP_ADMIN_LOGIN e BOOTSTRAP_ADMIN_PASSWORD.');
  const password_hash = await hashPassword(credentials.data.password);
  await db.atomic(async (tx) => {
    if (await tx.count('users')) return;
    await tx.insert(
      'users',
      mongoUser({
        name: 'Gestão Artisti',
        email: credentials.data.login,
        password_hash,
        role: 'manager',
      }),
    );
  });
}
