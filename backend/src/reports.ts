import { z } from 'zod';
import type { Document } from 'mongodb';
import type { Database } from './db.js';
import type { MongoStore, MongoTx } from './mongo-store.js';
import {
  DomainError,
  isClosedStage,
  isSaleStage,
  normalizeStage,
  requireManager,
  type User,
} from './types.js';

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const reportKinds = ['reservation.expired', 'opportunity.claimed', 'opportunity.updated'];
const dayMs = 86_400_000;
const businessTimeZone = 'America/Sao_Paulo';
const businessDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: businessTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export const reportsQuery = z
  .object({
    from: z.string().regex(datePattern).optional(),
    to: z.string().regex(datePattern).optional(),
  })
  .strict();

type ReportUser = Pick<User, 'id' | 'name' | 'active' | 'role'>;
interface ReportOpportunity {
  id: string;
  name: string;
  source: string;
  stage: string;
  state: string;
  reserved_to: string | null;
  owner_id: string | null;
  created_at: string | Date;
  claimed_at: string | Date | null;
  next_action: string;
}
interface ReportEvent {
  id: string;
  opportunity_id: string | null;
  actor_id: string | null;
  kind: string;
  details: Record<string, unknown> | string | null;
  created_at: string | Date;
}

interface ReportData {
  users: ReportUser[];
  periodOpportunities: ReportOpportunity[];
  referencedOpportunities: ReportOpportunity[];
  events: ReportEvent[];
  expiryHistory: ReportEvent[];
}

function businessParts(value: Date) {
  return Object.fromEntries(
    businessDateFormatter
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

const localDate = (value: Date) => {
  const parts = businessParts(value);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
};

function shiftDate(value: string, days: number) {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

function dateNumber(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const time = Date.UTC(year, month - 1, day);
  const normalized = new Date(time).toISOString().slice(0, 10);
  if (normalized !== value)
    throw new DomainError('INVALID_PERIOD', 'Informe um período válido.', 400);
  return time;
}

function startOfBusinessDate(value: string) {
  const [year, month, day] = value.split('-').map(Number);
  const intendedLocalTime = Date.UTC(year, month - 1, day);
  const probe = new Date(intendedLocalTime);
  const probeParts = businessParts(probe);
  const offset =
    Date.UTC(
      probeParts.year,
      probeParts.month - 1,
      probeParts.day,
      probeParts.hour,
      probeParts.minute,
      probeParts.second,
    ) - probe.getTime();
  return new Date(intendedLocalTime - offset);
}

export function reportPeriod(input: unknown, now: Date) {
  const query = reportsQuery.parse(input);
  const today = localDate(now);
  const to = query.to ?? today;
  const from = query.from ?? shiftDate(to, -30);
  const fromNumber = dateNumber(from);
  const toNumber = dateNumber(to);
  if (fromNumber > toNumber || (toNumber - fromNumber) / dayMs > 30)
    throw new DomainError('INVALID_PERIOD', 'O período não pode ultrapassar 31 dias.', 400);
  return {
    from,
    to,
    start: startOfBusinessDate(from),
    end: startOfBusinessDate(shiftDate(to, 1)),
  };
}

function details(value: ReportEvent['details']) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value;
}

function instant(value: string | Date) {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

async function sqlData(db: Database, start: Date, end: Date): Promise<ReportData> {
  return db.transaction(async (tx) => {
    if (db.kind === 'postgres')
      await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const users = (
      await tx.query<ReportUser>(
        "SELECT id,name,active,role FROM users WHERE role='attendant' ORDER BY queue_position NULLS LAST,name",
      )
    ).rows;
    const opportunitySql = `SELECT o.id,c.name,o.source,o.stage,o.state,o.reserved_to,o.owner_id,
      o.created_at,o.claimed_at,o.next_action FROM opportunities o
      JOIN contacts c ON c.id=o.contact_id`;
    const periodOpportunities = (
      await tx.query<ReportOpportunity>(
        `${opportunitySql} WHERE o.created_at >= $1 AND o.created_at < $2 ORDER BY o.created_at`,
        [start, end],
      )
    ).rows;
    const events = (
      await tx.query<ReportEvent>(
        `SELECT id,opportunity_id,actor_id,kind,details,created_at FROM audit_events
        WHERE created_at >= $1 AND created_at < $2 AND kind=ANY($3::text[])
        ORDER BY created_at,id`,
        [start, end, reportKinds],
      )
    ).rows;
    const periodIds = new Set(periodOpportunities.map((row) => row.id));
    const referencedIds = [
      ...new Set(
        events
          .map((event) => event.opportunity_id)
          .filter((id): id is string => !!id && !periodIds.has(id)),
      ),
    ];
    const referencedOpportunities = referencedIds.length
      ? (
          await tx.query<ReportOpportunity>(`${opportunitySql} WHERE o.id=ANY($1::uuid[])`, [
            referencedIds,
          ])
        ).rows
      : [];
    const claimIds = [
      ...new Set(
        events
          .filter((event) => event.kind === 'opportunity.claimed')
          .map((event) => event.opportunity_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const expiryHistory = claimIds.length
      ? (
          await tx.query<ReportEvent>(
            `SELECT id,opportunity_id,actor_id,kind,details,created_at FROM audit_events
            WHERE kind='reservation.expired' AND opportunity_id=ANY($1::uuid[]) AND created_at < $2`,
            [claimIds, end],
          )
        ).rows
      : [];
    return { users, periodOpportunities, referencedOpportunities, events, expiryHistory };
  });
}

async function mongoOpportunities(tx: MongoTx, filter: Document) {
  return (await tx
    .collection('opportunities')
    .aggregate(
      [
        { $match: filter },
        {
          $lookup: {
            from: 'contacts',
            localField: 'contact_id',
            foreignField: 'id',
            as: 'contact',
          },
        },
        { $unwind: '$contact' },
        {
          $project: {
            _id: 0,
            id: 1,
            name: '$contact.name',
            source: 1,
            stage: 1,
            state: 1,
            reserved_to: 1,
            owner_id: 1,
            created_at: 1,
            claimed_at: 1,
            next_action: 1,
          },
        },
        { $sort: { created_at: 1 } },
      ],
      { session: tx.session },
    )
    .toArray()) as unknown as ReportOpportunity[];
}

async function mongoData(db: MongoStore, start: Date, end: Date): Promise<ReportData> {
  return db.atomic(async (tx) => {
    const users = (
      await tx.many<ReportUser>('users', { role: 'attendant' }, { queue_position: 1 })
    ).map(({ id, name, active, role }) => ({ id, name, active, role }));
    const periodOpportunities = await mongoOpportunities(tx, {
      created_at: { $gte: start, $lt: end },
    });
    const events = await tx.many<ReportEvent>(
      'audit_events',
      { created_at: { $gte: start, $lt: end }, kind: { $in: reportKinds } },
      { created_at: 1, id: 1 },
    );
    const periodIds = new Set(periodOpportunities.map((row) => row.id));
    const referencedIds = [
      ...new Set(
        events
          .map((event) => event.opportunity_id)
          .filter((id): id is string => !!id && !periodIds.has(id)),
      ),
    ];
    const referencedOpportunities = referencedIds.length
      ? await mongoOpportunities(tx, { id: { $in: referencedIds } })
      : [];
    const claimIds = [
      ...new Set(
        events
          .filter((event) => event.kind === 'opportunity.claimed')
          .map((event) => event.opportunity_id)
          .filter((id): id is string => !!id),
      ),
    ];
    const expiryHistory = claimIds.length
      ? await tx.many<ReportEvent>('audit_events', {
          kind: 'reservation.expired',
          opportunity_id: { $in: claimIds },
          created_at: { $lt: end },
        })
      : [];
    return { users, periodOpportunities, referencedOpportunities, events, expiryHistory };
  }, true);
}

interface Bucket {
  count: number;
  lead_ids: Set<string>;
  minutes: number[];
}

function bucket(map: Map<string, Bucket>, key: string) {
  let value = map.get(key);
  if (!value) {
    value = { count: 0, lead_ids: new Set(), minutes: [] };
    map.set(key, value);
  }
  return value;
}

function userRanking(map: Map<string, Bucket>, users: Map<string, ReportUser>, average = false) {
  return [...map.entries()]
    .map(([user_id, value]) => ({
      user_id,
      name: users.get(user_id)?.name ?? 'Usuário removido',
      count: value.count,
      lead_ids: [...value.lead_ids],
      ...(average
        ? {
            average_minutes: value.minutes.length
              ? Math.round(
                  value.minutes.reduce((sum, item) => sum + item, 0) / value.minutes.length,
                )
              : 0,
          }
        : {}),
    }))
    .sort((a, b) =>
      average
        ? (a.average_minutes ?? 0) - (b.average_minutes ?? 0) || b.count - a.count
        : b.count - a.count || a.name.localeCompare(b.name, 'pt-BR'),
    );
}

function buildReport(data: ReportData, from: string, to: string) {
  const users = new Map(data.users.map((user) => [user.id, user]));
  const opportunities = new Map(
    [...data.periodOpportunities, ...data.referencedOpportunities].map((row) => [row.id, row]),
  );
  const leadNames = Object.fromEntries(
    [...opportunities.values()].map((row) => [row.id, { id: row.id, name: row.name }]),
  );
  const claimEvents = data.events.filter(
    (event) => event.kind === 'opportunity.claimed' && event.opportunity_id && event.actor_id,
  );
  const expiredEvents = data.events.filter(
    (event) => event.kind === 'reservation.expired' && event.opportunity_id,
  );
  const unanswered = new Map<string, Bucket>();
  for (const event of expiredEvents) {
    const userId = details(event.details).reserved_to;
    if (typeof userId !== 'string') continue;
    const value = bucket(unanswered, userId);
    value.count++;
    value.lead_ids.add(event.opportunity_id!);
  }
  const response = new Map<string, Bucket>();
  const sameDay = new Map<string, Bucket>();
  const delays: number[] = [];
  for (const event of claimEvents) {
    const row = opportunities.get(event.opportunity_id!);
    if (!row) continue;
    const delay = Math.max(0, (instant(event.created_at) - instant(row.created_at)) / 60_000);
    const value = bucket(response, event.actor_id!);
    value.count++;
    value.minutes.push(delay);
    value.lead_ids.add(row.id);
    delays.push(delay);
    if (
      localDate(new Date(instant(event.created_at))) ===
      localDate(new Date(instant(row.created_at)))
    ) {
      const date = localDate(new Date(instant(event.created_at)));
      const daily = bucket(sameDay, date);
      daily.count++;
      daily.lead_ids.add(row.id);
    }
  }
  const expiryByLead = new Map<string, number[]>();
  for (const event of data.expiryHistory) {
    if (!event.opportunity_id) continue;
    const rows = expiryByLead.get(event.opportunity_id) ?? [];
    rows.push(instant(event.created_at));
    expiryByLead.set(event.opportunity_id, rows);
  }
  const poolCaptured = new Map<string, Bucket>();
  for (const event of claimEvents) {
    if (
      !expiryByLead
        .get(event.opportunity_id!)
        ?.some((expiredAt) => expiredAt <= instant(event.created_at))
    )
      continue;
    const value = bucket(poolCaptured, event.actor_id!);
    value.count++;
    value.lead_ids.add(event.opportunity_id!);
  }
  const sources = new Map<string, Bucket>();
  for (const row of data.periodOpportunities) {
    const value = bucket(sources, row.source.trim() || 'Não identificada');
    value.count++;
    value.lead_ids.add(row.id);
  }
  const won = new Map<string, Bucket>();
  for (const event of data.events.filter((item) => item.kind === 'opportunity.updated')) {
    const transition = details(event.details);
    const nextStage = normalizeStage(String(transition.next_stage ?? ''));
    const previousStage = normalizeStage(String(transition.previous_stage ?? ''));
    if (
      !nextStage ||
      !isSaleStage(nextStage) ||
      (previousStage !== undefined && isSaleStage(previousStage)) ||
      !event.opportunity_id
    )
      continue;
    const row = opportunities.get(event.opportunity_id);
    const userId = row?.owner_id ?? event.actor_id;
    if (!userId) continue;
    const value = bucket(won, userId);
    value.count++;
    value.lead_ids.add(event.opportunity_id);
  }
  const activities = new Map<string, Bucket>();
  for (const row of data.periodOpportunities) {
    if (!row.owner_id || isClosedStage(row.stage) || !row.next_action.trim()) continue;
    const value = bucket(activities, row.owner_id);
    value.count++;
    value.lead_ids.add(row.id);
  }
  const funnelDefinitions = [
    ['RECEIVED', 'Recebidos', () => true],
    ['NEW_LEAD', 'Novos leads', (row: ReportOpportunity) => row.stage === 'NEW_LEAD'],
    [
      'CONSULTATION_NOT_SCHEDULED',
      'Consulta não agendada',
      (row: ReportOpportunity) => row.stage === 'CONSULTATION_NOT_SCHEDULED',
    ],
    ['FOLLOW_UP', 'Em follow-up', (row: ReportOpportunity) => row.stage === 'FOLLOW_UP'],
    [
      'CONTRACT_PENDING',
      'Contrato pendente',
      (row: ReportOpportunity) => row.stage === 'CONTRACT_PENDING',
    ],
    [
      'CLOSED_WITH_DATE',
      'Fechado com data',
      (row: ReportOpportunity) => row.stage === 'CLOSED_WITH_DATE',
    ],
    [
      'CLOSED_WITHOUT_DATE',
      'Fechado sem data',
      (row: ReportOpportunity) => row.stage === 'CLOSED_WITHOUT_DATE',
    ],
    ['DECLINED', 'Declinado', (row: ReportOpportunity) => row.stage === 'DECLINED'],
  ] as const;
  return {
    period: { from, to, days: (dateNumber(to) - dateNumber(from)) / dayMs + 1 },
    leads: leadNames,
    unanswered_by_user: userRanking(unanswered, users),
    fastest_response_by_user: userRanking(response, users, true),
    top_sources: [...sources.entries()]
      .map(([source, value]) => ({
        source,
        count: value.count,
        lead_ids: [...value.lead_ids],
      }))
      .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source, 'pt-BR')),
    funnel: funnelDefinitions.map(([key, label, matches]) => {
      const rows = data.periodOpportunities.filter(matches);
      return { key, label, count: rows.length, lead_ids: rows.map((row) => row.id) };
    }),
    average_response_minutes: delays.length
      ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length)
      : null,
    pool_claimed_by_user: userRanking(poolCaptured, users),
    pool_lost_by_user: userRanking(unanswered, users),
    same_day_interactions: [...sameDay.entries()]
      .map(([date, value]) => ({ date, count: value.count, lead_ids: [...value.lead_ids] }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    first_interaction_by_user: userRanking(response, users, true),
    closed_by_user: userRanking(won, users),
    open_activities_by_user: userRanking(activities, users),
  };
}

export async function reportsOverview(
  db: Database | MongoStore,
  user: User,
  input: unknown,
  now: () => Promise<Date>,
) {
  requireManager(user);
  const clock = await now();
  const period = reportPeriod(input, clock);
  const data =
    db.kind === 'mongo'
      ? await mongoData(db, period.start, period.end)
      : await sqlData(db, period.start, period.end);
  return { ...buildReport(data, period.from, period.to), server_time: clock.toISOString() };
}
