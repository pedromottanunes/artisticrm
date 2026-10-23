import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { CommercialExtraction } from '../src/commercial-api';

test.use({ serviceWorkers: 'block' });
const headers = { 'X-Artisti-Client': 'web' };
async function login(page: Page, profile: 'cadu' | 'vanessa') {
  const response = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBeTruthy();
}
async function createPatient(page: Page) {
  const name = `Paciente Documento ${randomUUID().slice(0, 6)}`;
  const response = await page.request.post('/api/v1/opportunities', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      name,
      phone: `55489${Math.floor(10000000 + Math.random() * 89999999)}`,
      unit: 'Teste',
      source: 'Indicação',
    },
  });
  expect(response.ok()).toBeTruthy();
  return { id: (await response.json()).id as string, name };
}
async function openPatient(page: Page, name: string) {
  await page.goto('/#lists');
  await page.getByRole('button', { name: `Abrir ficha de ${name}`, exact: true }).click();
  const panel = page.getByRole('region', { name: 'Documentos, sinal e comissão' });
  await expect(panel.getByText('Sinal confirmado', { exact: true })).toBeVisible();
  return panel;
}

test('documentos: envio real, revisão da gestão e layout adaptável', async ({ page }, info) => {
  await login(page, 'vanessa');
  const patient = await createPatient(page);
  let panel = await openPatient(page, patient.name);
  const png = await sharp({
    create: {
      width: 420,
      height: 600,
      channels: 3,
      background: `#${randomUUID().replaceAll('-', '').slice(0, 6)}`,
    },
  })
    .png()
    .toBuffer();
  await panel
    .locator('input[type=file]')
    .setInputFiles({ name: 'comprovante-teste.png', mimeType: 'image/png', buffer: png });
  await panel.getByRole('button', { name: 'Enviar para checagem', exact: true }).click();
  await expect(panel.getByText('Revisão necessária', { exact: true }).first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Revisar', exact: true })).toHaveCount(0);
  const result = await page.request.get(`/api/v1/opportunities/${patient.id}/commercial`);
  expect((await result.json()).assessment.confirmed_cents).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: `test-results/commercial-consultor-${info.project.name}.png`,
    fullPage: true,
  });
  await login(page, 'cadu');
  await page.reload();
  panel = await openPatient(page, patient.name);
  await panel.getByRole('button', { name: 'Revisar', exact: true }).click();
  const review = panel.getByRole('group', { name: 'Revisão humana' });
  await review.getByLabel('Paciente identificado').fill(patient.name);
  await review.getByLabel('Valor recebido (R$)').fill('500');
  await review.getByLabel('Data efetiva do pagamento').fill('2026-10-01');
  await review.getByLabel('Situação da transação').selectOption('completed');
  await review.getByLabel('Identificador da transação').fill(`TEST-${randomUUID()}`);
  await review
    .getByLabel('Justificativa da decisão')
    .fill('Comprovante sintético conferido no teste automatizado.');
  await review
    .getByLabel('Conferi os documentos, o vínculo com o paciente e os dados acima.')
    .check();
  await review.getByRole('button', { name: 'Confirmar fatos conferidos' }).click();
  await expect(review).toHaveCount(0);
  await expect(panel.getByText('Validado', { exact: true }).first()).toBeVisible();
  const confirmed = await (
    await page.request.get(`/api/v1/opportunities/${patient.id}/commercial`)
  ).json();
  expect(confirmed.assessment.confirmed_cents).toBe(50000);
  expect(confirmed.assessment.eligible).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await panel.locator('.ce-heading').scrollIntoViewIfNeeded();
  await page.screenshot({ path: `test-results/commercial-gestao-${info.project.name}.png` });
  await page
    .getByRole('button', {
      name: info.project.use.isMobile ? 'Voltar da ficha do lead' : 'Fechar janela',
      exact: true,
    })
    .click();
  await page.getByText('Sinal, contratos e elegibilidade de comissão', { exact: true }).click();
  const list = page.locator('.ce-list');
  await expect(list.getByText(patient.name, { exact: true })).toBeVisible();
});

test('documentos: leitura não sobrescreve campo editado; preenche campos vazios', async ({
  page,
}) => {
  await login(page, 'vanessa');
  const patient = await createPatient(page);
  let suggestions = false;
  await page.route(`**/api/v1/opportunities/${patient.id}/commercial`, async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (suggestions)
      data.suggestions = {
        total_value_cents: {
          value: 1550000,
          evidence_ids: [],
          validated_at: '2026-10-22T12:00:00Z',
        },
        hair_grade_classification: {
          value: 'Grau 3 A1',
          evidence_ids: [],
          validated_at: '2026-10-22T12:00:00Z',
        },
        pack_quantity: { value: 2, evidence_ids: [], validated_at: '2026-10-22T12:00:00Z' },
      };
    await route.fulfill({ response, json: data });
  });
  const panel = await openPatient(page, patient.name);
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Valor total', { exact: true }).fill('17.000,00');
  suggestions = true;
  await panel.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(dialog.getByLabel('Grau e classificação A')).toHaveValue('Grau 3 A1');
  await expect(dialog.getByLabel('Valor total', { exact: true })).toHaveValue('17.000,00');
  await expect(dialog.getByLabel('Quantidade de packs')).toHaveValue('2');
  await expect(dialog.getByLabel('Teve pack?')).toHaveValue('true');
});

test('documentos: revisão humana não bloqueia nem submete o cadastro da venda', async ({
  page,
}, info) => {
  await login(page, 'vanessa');
  const patient = await createPatient(page);
  const base = `/api/v1/opportunities/${patient.id}/commercial`;
  const png = await sharp({
    create: {
      width: 80,
      height: 80,
      channels: 3,
      background: `#${randomUUID().replaceAll('-', '').slice(0, 6)}`,
    },
  })
    .png()
    .toBuffer();
  const upload = await page.request.post(base + '/evidence?category=payment', {
    headers: { ...headers, 'Idempotency-Key': randomUUID(), 'Content-Type': 'image/png' },
    data: png,
  });
  expect(upload.ok()).toBeTruthy();
  const { evidence_id, revision } = await upload.json();
  const analysis = await page.request.post(base + '/analyses', {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: { evidence_ids: [evidence_id], expected_revision: revision },
  });
  expect(analysis.ok()).toBeTruthy();
  await login(page, 'cadu');
  const panel = await openPatient(page, patient.name);
  await panel.getByRole('button', { name: 'Revisar', exact: true }).click();
  const review = panel.getByRole('group', { name: 'Revisão humana' });
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Cidade de residência', { exact: true }).fill('Florianópolis');
  await dialog.getByLabel('Consultor', { exact: true }).fill('Vanessa');
  await dialog.getByLabel('Valor total', { exact: true }).fill('15500,00');
  await dialog.getByLabel('Valor da entrada', { exact: true }).fill('2000,00');
  await dialog.getByLabel('Grau e classificação A').fill('3A');
  const form = dialog.locator('form').filter({ has: page.locator('[name="consultant"]') });
  expect(await form.evaluate((node) => (node as HTMLFormElement).checkValidity())).toBe(true);
  await review.getByLabel('Valor recebido (R$)').fill('0');
  expect.soft(await form.evaluate((node) => (node as HTMLFormElement).checkValidity())).toBe(true);
  await review.getByLabel('Valor recebido (R$)').fill('500');
  await form.evaluate((node) => {
    node.setAttribute('data-test-submits', '0');
    node.addEventListener('submit', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      node.setAttribute(
        'data-test-submits',
        String(Number(node.getAttribute('data-test-submits')) + 1),
      );
    });
  });
  await review.getByLabel('Paciente identificado').fill(patient.name);
  await review.getByLabel('Paciente identificado').press('Enter');
  await expect(form).toHaveAttribute('data-test-submits', '0');
  await review.getByLabel('Valor recebido (R$)').fill('0');
  if (info.project.use.isMobile) await dialog.getByLabel('Mais ações do lead').click();
  await dialog
    .locator('button:visible')
    .filter({ hasText: /^Registrar venda$/ })
    .click();
  await dialog
    .getByRole('group', { name: 'Confirmação da venda' })
    .getByRole('button', { name: 'Confirmar venda', exact: true })
    .click();
  await expect(dialog.getByText('Venda registrada', { exact: true })).toBeVisible();
  const state = await (await page.request.get(base)).json();
  expect(state.assessment.confirmed_cents).toBe(0);
  expect(state.assessment.eligible).toBe(false);
});

test('documentos: correção e revogação reais atualizam rascunho automático, preservando edição manual', async ({
  page,
  request,
}) => {
  await login(page, 'vanessa');
  const auth = await request.post('/api/v1/auth/login', {
    headers,
    data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(auth.ok()).toBeTruthy();
  const patient = await createPatient(page);
  const base = `/api/v1/opportunities/${patient.id}/commercial`;
  const summary = async () => (await page.request.get(base)).json();
  const post = async (path: string, data: unknown, management = false) => {
    const response = await (management ? request : page.request).post(base + path, {
      headers: { ...headers, 'Idempotency-Key': randomUUID() },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const proof = async (value: number) => {
    const png = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 3,
        background: `#${randomUUID().replaceAll('-', '').slice(0, 6)}`,
      },
    })
      .png()
      .toBuffer();
    const upload = await page.request.post(base + '/evidence?category=contract_summary', {
      headers: { ...headers, 'Idempotency-Key': randomUUID(), 'Content-Type': 'image/png' },
      data: png,
    });
    expect(upload.ok()).toBeTruthy();
    const { evidence_id } = await upload.json();
    const { job_id } = await post('/analyses', {
      evidence_ids: [evidence_id],
      expected_revision: (await summary()).revision,
    });
    const result: CommercialExtraction = {
      patient_name: patient.name,
      readable: true,
      warnings: [],
      payment: null,
      contract: null,
      fields: {
        total_value_cents: value,
        hair_grade_classification: 'Grau 3 A1',
        pack_quantity: 2,
        procedure_date: '2026-12-07',
      },
    };
    await post(
      `/analyses/${job_id}/review`,
      {
        expected_revision: (await summary()).revision,
        decision: 'confirm',
        result,
        reason: 'Conferência de imagem sintética para teste de regressão.',
      },
      true,
    );
    return evidence_id;
  };
  const first = await proof(1550000);
  const panel = await openPatient(page, patient.name);
  const dialog = page.getByRole('dialog');
  const total = dialog.getByLabel('Valor total', { exact: true });
  const grade = dialog.getByLabel('Grau e classificação A');
  const date = dialog.getByLabel('Data da cirurgia');
  await expect(total).toHaveValue('15500,00');
  await expect(date).toHaveValue('2026-12-07');
  await grade.fill('Grau 4 manual');
  await post(`/evidence/${first}/supersede`, {
    expected_revision: (await summary()).revision,
    reason: 'Documento anterior incorreto, substituído no teste.',
  });
  await panel.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(total).toHaveValue('');
  await expect(date).toHaveValue('');
  await expect(grade).toHaveValue('Grau 4 manual');
  await expect(dialog.getByLabel('Teve pack?')).toHaveValue('false');
  await expect(dialog.getByLabel('Quantidade de packs')).toBeDisabled();
  await proof(1700000);
  await panel.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(total).toHaveValue('17000,00');
  await expect(dialog.getByLabel('Quantidade de packs')).toHaveValue('2');
  const corrected = await proof(1800000);
  await panel.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(total).toHaveValue('18000,00');
  await expect(grade).toHaveValue('Grau 4 manual');
  await total.fill('19.000,00');
  await post(`/evidence/${corrected}/supersede`, {
    expected_revision: (await summary()).revision,
    reason: 'Revogação após edição manual no teste de regressão.',
  });
  await panel.getByRole('button', { name: 'Atualizar', exact: true }).click();
  await expect(total).toHaveValue('19.000,00');
  await expect(grade).toHaveValue('Grau 4 manual');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('documentos: venda sem anexos aparece na lista sem validar valores declarados', async ({
  page,
}) => {
  await login(page, 'vanessa');
  const patient = await createPatient(page);
  const detail = await (await page.request.get(`/api/v1/opportunities/${patient.id}`)).json();
  const saved = await page.request.put(`/api/v1/opportunities/${patient.id}/sale`, {
    headers: { ...headers, 'Idempotency-Key': randomUUID() },
    data: {
      expected_version: detail.version,
      name: patient.name,
      phone: detail.phone,
      residence_city: 'Florianópolis',
      consultant: 'Vanessa',
      total_value_cents: 1550000,
      down_payment_cents: 200000,
      hair_grade_classification: '3A',
      has_pack: false,
      unit: 'Teste',
      procedure_date: null,
      contract_status: 'signed',
    },
  });
  expect(saved.ok(), await saved.text()).toBeTruthy();
  await page.goto('/#lists');
  await page.getByText('Sinal, contratos e elegibilidade de comissão', { exact: true }).click();
  const row = page.locator('.ce-list-item').filter({ hasText: patient.name });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Sinal incompleto');
  await expect(row).toContainText('Assinatura pendente de validação');
  await expect(row.locator('strong').last()).toHaveText('R$ 0,00');
  await row.getByRole('button', { name: 'Abrir paciente' }).click();
  await expect(page.getByRole('dialog').getByLabel('Valor total', { exact: true })).toHaveValue(
    '15500,00',
  );
});
