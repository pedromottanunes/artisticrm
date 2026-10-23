import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessCommercial, saoPauloDate } from '../src/commercial-domain.js';

const payment = (date: string, amount = 200000, id = date) => ({
  id,
  paid_on: date,
  amount_cents: amount,
  status: 'confirmed' as const,
});
const assess = (
  payments: ReturnType<typeof payment>[],
  signed: string | null,
  today = '2027-02-01',
) =>
  assessCommercial({
    payments,
    contract: signed ? { status: 'confirmed', signed_on: signed } : null,
    sale_registered: true,
    today,
  });
for (const [first, completed, signed, expected] of [
  ['2026-11-03', '2026-11-03', '2026-11-08', '2026-12-10'],
  ['2026-11-29', '2026-11-29', '2026-12-05', '2026-12-10'],
  ['2026-11-30', '2026-11-30', '2026-12-06', '2027-01-10'],
  ['2026-12-05', '2026-12-05', '2026-11-28', '2026-12-10'],
  ['2026-11-30', '2026-12-05', '2026-12-05', '2026-12-10'],
  ['2026-11-30', '2026-12-06', '2026-11-28', '2027-01-10'],
  ['2026-12-01', '2026-12-01', '2026-12-03', '2027-01-10'],
  ['2026-11-30', '2026-11-30', '2027-01-05', '2027-01-10'],
  ['2026-11-30', '2026-11-30', '2027-01-06', '2027-02-10'],
])
  test(`Cadu: ${first} / ${completed} / ${signed} => ${expected}`, () => {
    const result = assess(
      [payment(first, 50000, 'first'), payment(completed, 150000, 'rest')],
      signed,
    );
    assert.equal(result.eligible, true);
    assert.equal(result.expected_payment_on, expected);
  });
test('sinal não dispensa contrato e contrato não dispensa sinal', () => {
  assert.equal(assess([payment('2026-11-03')], null).eligible, false);
  assert.equal(assess([], '2026-11-03').eligible, false);
});
test('pendentes, rejeitados e substituídos não entram no confirmado; ordem não importa', () => {
  const result = assessCommercial({
    payments: [
      payment('2026-12-05', 150000),
      payment('2026-11-30', 50000),
      { ...payment('2026-11-01', 200000), status: 'pending' },
    ],
    contract: { status: 'confirmed', signed_on: '2026-11-28' },
    sale_registered: true,
    today: '2026-12-06',
  });
  assert.equal(result.confirmed_cents, 200000);
  assert.equal(result.pending_cents, 200000);
  assert.equal(result.deposit_completed_on, '2026-12-05');
  assert.equal(result.expected_payment_on, '2026-12-10');
});
test('passagem do dia 5 atualiza previsão condicional sem fingir elegibilidade', () => {
  const payments = [payment('2026-11-30', 50000)];
  assert.equal(assess(payments, null, '2026-12-05').conditional_payment_on, '2026-12-10');
  assert.equal(assess(payments, null, '2026-12-06').conditional_payment_on, '2027-01-10');
  assert.equal(assess(payments, null).commission_period, null);
});
test('sem venda registrada, sem elegibilidade; sem fatos, sem previsão', () => {
  assert.equal(
    assessCommercial({
      payments: [payment('2026-11-03')],
      contract: { status: 'confirmed', signed_on: '2026-11-04' },
      sale_registered: false,
      today: '2026-11-05',
    }).eligible,
    false,
  );
  assert.equal(assess([], null).conditional_payment_on, null);
});
test('vigência: outubro exige 2 mil; travessia histórica não é escolhida silenciosamente', () => {
  assert.equal(assess([payment('2026-10-01', 150000)], '2026-10-01').eligible, false);
  assert.equal(assess([payment('2026-09-10', 150000)], '2026-09-11').eligible, true);
  assert.ok(
    assess([payment('2026-09-30', 150000)], '2026-10-01').reasons.includes('LEGACY_POLICY_REVIEW'),
  );
});
test('datas impossíveis, futuras e pagamentos duplicados são recusados', () => {
  assert.throws(() => assess([payment('2026-11-31')], null));
  assert.throws(() => assess([payment('2028-11-01')], null));
  assert.throws(() => assess([payment('2026-11-01'), payment('2026-11-01')], null));
  assert.throws(() => assess([payment('2026-11-01', 10.5)], null));
});
test('fuso de São Paulo não antecipa o dia 6 na virada UTC', () => {
  assert.equal(saoPauloDate(new Date('2026-12-06T02:59:59Z')), '2026-12-05');
  assert.equal(saoPauloDate(new Date('2026-12-06T03:00:00Z')), '2026-12-06');
});
