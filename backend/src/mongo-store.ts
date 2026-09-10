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
  for (const name of ['users', 'contacts', 'opportunities', 'appointments', 'audit_events'])
    await db.collection(name).createIndex({ id: 1 }, { unique: true });
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db
    .collection('users')
    .createIndex(
      { queue_position: 1 },
      { unique: true, partialFilterExpression: { queue_position: { $type: 'number' } } },
    );
  await db.collection('contacts').createIndex({ phone: 1 }, { unique: true });
  await db
    .collection('opportunities')
    .createIndex({ contact_id: 1 }, { unique: true, partialFilterExpression: { open: true } });
  await db.collection('opportunities').createIndex({ state: 1, expires_at: 1 });
  await db.collection('opportunities').createIndex({ owner_id: 1, created_at: -1 });
  await db.collection('opportunities').createIndex({ state: 1, reserved_to: 1 });
  await db.collection('opportunities').createIndex({ created_at: -1 });
  await db.collection('appointments').createIndex({ opportunity_id: 1, status: 1 });
  await db
    .collection('appointments')
    .createIndex(
      { opportunity_id: 1 },
      { unique: true, partialFilterExpression: { status: 'scheduled' } },
    );
  await db.collection('audit_events').createIndex({ opportunity_id: 1, created_at: -1 });
  await db.collection('inbound_events').createIndex({ external_id: 1 }, { unique: true });
  await db.collection('claims').createIndex({ user_id: 1, key: 1 }, { unique: true });
  await db.collection('operation_receipts').createIndex({ actor_id: 1, key: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ token_hash: 1 }, { unique: true });
  await db.collection('sessions').createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
  await db.collection('whatsapp_inbox').createIndex({ event_id: 1 }, { unique: true });
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
    must_change_password: false,
    color: '#EDB25A',
    ...input,
    email: input.email.toLowerCase(),
  };
}

export async function bootstrapMongo(db: MongoStore, email?: string, password?: string) {
  if (await db.count('users', { email: /@demo\.artisti\.local$/ }))
    throw new Error('Banco contém usuários demo. Use outro banco para homologação.');
  if (await db.count('users')) return;
  const credentials = z
    .object({ email: z.string().email().max(200), password: z.string().min(6).max(128) })
    .safeParse({ email, password });
  if (!credentials.success || credentials.data.email.endsWith('@demo.artisti.local'))
    throw new Error(
      'Banco vazio: configure BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD (6 a 128 caracteres).',
    );
  const password_hash = await hashPassword(credentials.data.password);
  await db.atomic(async (tx) => {
    if (await tx.count('users')) return;
    await tx.insert(
      'users',
      mongoUser({
        name: 'Gestão Artisti',
        email: credentials.data.email,
        password_hash,
        role: 'manager',
      }),
    );
  });
}
