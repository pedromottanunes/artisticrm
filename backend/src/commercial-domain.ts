import { DomainError, isValidDateOnly } from './types.js';

// This is a calendar rule, not an AI decision or a payout instruction.
export const COMMERCIAL_RULE_VERSION = 'cadu-2026-10-22';
export const DEPOSIT_RULE_START = '2026-10-01';
export type Verification = 'pending' | 'confirmed' | 'rejected' | 'superseded';
export interface VerifiedPayment {
  id: string;
  amount_cents: number;
  paid_on: string;
  status: Verification;
}
export interface VerifiedContract {
  signed_on: string | null;
  status: Verification;
}
export function saoPauloDate(now: Date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}
export function shiftMonth(month: string, delta: number) {
  const [year, number] = month.split('-').map(Number);
  return new Date(Date.UTC(year, number - 1 + delta, 1)).toISOString().slice(0, 7);
}
function assertDate(date: string) {
  if (!isValidDateOnly(date))
    throw new DomainError('INVALID_COMMERCIAL_DATE', 'Informe uma data completa e válida.', 400);
}

export function assessCommercial(input: {
  payments: VerifiedPayment[];
  contract: VerifiedContract | null;
  sale_registered: boolean;
  today: string;
  blocking_review?: boolean;
  legacy_minimum_cents?: 150000 | 200000;
}) {
  assertDate(input.today);
  const seen = new Set<string>();
  for (const payment of input.payments) {
    assertDate(payment.paid_on);
    if (
      seen.has(payment.id) ||
      !Number.isSafeInteger(payment.amount_cents) ||
      payment.amount_cents <= 0 ||
      payment.amount_cents > 2_000_000_000
    )
      throw new DomainError('INVALID_PAYMENT', 'Pagamento inválido ou repetido.', 400);
    seen.add(payment.id);
    if (payment.status === 'confirmed' && payment.paid_on > input.today)
      throw new DomainError('FUTURE_PAYMENT', 'Pagamento futuro não pode ser confirmado.', 400);
  }
  const signed = input.contract?.status === 'confirmed' ? input.contract.signed_on : null;
  if (signed) {
    assertDate(signed);
    if (signed > input.today)
      throw new DomainError('FUTURE_SIGNATURE', 'Assinatura futura não pode ser confirmada.', 400);
  }
  const confirmed = input.payments
    .filter((p) => p.status === 'confirmed')
    .sort((a, b) => a.paid_on.localeCompare(b.paid_on) || a.id.localeCompare(b.id));
  const firstPayment = confirmed[0]?.paid_on ?? null;
  const started = [firstPayment, signed].filter((d): d is string => !!d).sort()[0] ?? null;
  // No inference from legacy free-text amounts. Cross-cutover cases need an explicit
  // manager decision rather than silently choosing the cheaper historical threshold.
  const historical = !!started && started < DEPOSIT_RULE_START;
  const minimum = historical ? (input.legacy_minimum_cents ?? 150000) : 200000;
  let total = 0;
  let completed: string | null = null;
  for (const payment of confirmed) {
    total += payment.amount_cents;
    if (!Number.isSafeInteger(total))
      throw new DomainError('INVALID_PAYMENT', 'Total inválido.', 400);
    if (!completed && total >= minimum) completed = payment.paid_on;
  }
  const fulfilled = completed && signed ? [completed, signed].sort()[1] : null;
  const legacyReview =
    historical && !input.legacy_minimum_cents && (!fulfilled || fulfilled >= DEPOSIT_RULE_START);
  const reasons: string[] = [];
  if (!completed) reasons.push('DEPOSIT_INCOMPLETE');
  if (!signed) reasons.push('CONTRACT_PENDING');
  if (!input.sale_registered) reasons.push('SALE_NOT_REGISTERED');
  if (legacyReview) reasons.push('LEGACY_POLICY_REVIEW');
  if (input.blocking_review) reasons.push('EVIDENCE_REVIEW');

  // Earliest month >= start month with completion <= the fifth of the next month.
  // Never pull a newly started December sale into November just because it is Dec 1–5.
  const periodFor = (date: string) => {
    const byCompletion =
      Number(date.slice(8)) <= 5 ? shiftMonth(date.slice(0, 7), -1) : date.slice(0, 7);
    return [started!.slice(0, 7), byCompletion].sort()[1];
  };
  const eligible = reasons.length === 0;
  const period = eligible && fulfilled ? periodFor(fulfilled) : null;
  const conditionalPeriod = !eligible && started ? periodFor(input.today) : null;
  return {
    rule_version: COMMERCIAL_RULE_VERSION,
    minimum_cents: minimum,
    confirmed_cents: total,
    pending_cents: input.payments
      .filter((p) => p.status === 'pending')
      .reduce((sum, p) => sum + p.amount_cents, 0),
    remaining_cents: Math.max(0, minimum - total),
    first_payment_on: firstPayment,
    deposit_completed_on: completed,
    contract_signed_on: signed,
    closing_started_on: started,
    requirements_completed_on: fulfilled,
    eligible,
    reasons,
    commission_period: period,
    expected_payment_on: period ? `${shiftMonth(period, 1)}-10` : null,
    conditional_payment_on: conditionalPeriod ? `${shiftMonth(conditionalPeriod, 1)}-10` : null,
    conditional_deadline_on: conditionalPeriod ? `${shiftMonth(conditionalPeriod, 1)}-05` : null,
  };
}
export type CommercialAssessment = ReturnType<typeof assessCommercial>;
