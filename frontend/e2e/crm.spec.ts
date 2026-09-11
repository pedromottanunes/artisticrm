import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Reuse demo sessions across isolated pages; repeated UI login isn't the purpose
// of every regression and would exhaust the real login rate limit for one IP.
const demoSessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();

test('gestão consulta central desligada em viewport móvel sem expor configuração', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  await login(page);
  // Navigate through the desktop-sized menu first, then inspect the same panel on mobile.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'WhatsApp central', exact: true }) });
  await expect(panel.getByText('Desligado', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByText('A central não envia respostas.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
async function login(page: Page, profile = 'cadu') {
  const cookies = demoSessions.get(profile);
  if (cookies) await page.context().addCookies(cookies);
  await page.goto('/');
  if (cookies && (await page.request.get('/api/v1/me')).ok()) {
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    return;
  }
  await page.getByLabel('Escolha um perfil de demonstração').selectOption(profile);
  await page.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  demoSessions.set(profile, await page.context().cookies());
}

test('tipografia permanece legível em desktop amplo e celular', async ({ page }) => {
  const unreadableText = async () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((element) => {
          const box = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            element.children.length === 0 &&
            !!element.textContent?.trim() &&
            !element.classList.contains('sr-only') &&
            box.width > 0 &&
            box.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden'
          );
        })
        .map((element) => ({
          text: element.textContent!.trim().slice(0, 80),
          size: parseFloat(getComputedStyle(element).fontSize),
        }))
        .filter(({ size }) => size < 12),
    );

  await page.setViewportSize({ width: 1874, height: 920 });
  await login(page);
  expect(await unreadableText()).toEqual([]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  expect(await unreadableText()).toEqual([]);
  const layout = await page.evaluate(() => {
    const table = document.querySelector<HTMLElement>('.table-scroll')!;
    return {
      bodyWidth: document.body.scrollWidth,
      viewport: innerWidth,
      pageOverflowIsClipped: getComputedStyle(document.documentElement).overflowX === 'hidden',
      tableCanScrollInternally: table.scrollWidth > table.clientWidth,
    };
  });
  expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewport);
  expect(layout.pageOverflowIsClipped).toBe(true);
  expect(layout.tableCanScrollInternally).toBe(true);
});
test('gestão navega, filtra e cadastra lead persistente', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.getByRole('heading', { name: 'Visão geral' })).toBeVisible();
  await page.screenshot({ path: 'test-results/gestao-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do contato').fill('Teste Navegador');
  await dialog.getByLabel('WhatsApp com país e DDD').fill(`5548${String(Date.now()).slice(-9)}`);
  await dialog.getByRole('button', { name: 'Cadastrar e distribuir' }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Teste Navegador');
  await expect(page.getByRole('table').getByText('Teste Navegador').first()).toBeVisible();
  await page.getByRole('button', { name: 'Meta Ads', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Meta Ads' })).toBeVisible();
  await expect(page.getByText('Integração ainda não configurada')).toBeVisible();
  expect(errors).toEqual([]);
});
test('atendimento móvel acessa bolsão e confirma aceite sem abrir contato fictício', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'vanessa');
  await expect(page.getByRole('heading', { name: 'Meus atendimentos' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Atalhos de atendimento' })
    .getByRole('button', { name: 'Bolsão' })
    .click();
  await expect(page.getByRole('heading', { name: 'Bolsão', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/atendimento-mobile.png', fullPage: true });
  const claim = page.getByRole('button', { name: 'Assumir lead' }).first();
  await expect(claim).toBeVisible();
  await claim.click();
  await expect(page.getByRole('status').filter({ hasText: 'Contato fictício' })).toBeVisible();
  expect(
    await page.evaluate(() => {
      scrollTo(1000, 0);
      return scrollX === 0 && document.body.scrollWidth <= innerWidth;
    }),
  ).toBe(true);
  await page
    .getByRole('navigation', { name: 'Atalhos de atendimento' })
    .getByRole('button', { name: 'Meus leads' })
    .click();
  await expect(page.getByText('WhatsApp', { exact: true }).first()).toBeVisible();
});
test('ficha edita cadastro, agenda avaliação e preserva histórico', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Gustavo Pereira');
  await page.getByRole('button', { name: 'Abrir ficha de Gustavo Pereira' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Próxima ação').fill('Retorno de teste agendado');
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(dialog.getByRole('button', { name: 'Salvar alterações' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Agendar avaliação', exact: true }).click();
  await dialog.getByLabel('Data e horário').fill('2027-10-01T15:30');
  await dialog.getByRole('button', { name: 'Confirmar avaliação' }).click();
  await expect(dialog.getByText(/Avaliação agendada por Cadu/).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Avaliações', exact: true }).click();
  await dialog.getByRole('button', { name: 'Alterar avaliação' }).click();
  await dialog.getByLabel('Ação na avaliação').selectOption('cancelled');
  await dialog.getByLabel('Motivo', { exact: true }).fill('Cancelamento solicitado no teste');
  await dialog.getByRole('button', { name: 'Salvar avaliação' }).click();
  await expect(dialog.getByText(/· Cancelada/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(dialog.getByText(/Avaliação cancelada/)).toBeVisible();
});
test('painel móvel sem transbordamento e menu utilizável', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  await page.waitForTimeout(250);
  expect(
    await page.evaluate(
      () =>
        document.body.scrollWidth <= innerWidth &&
        getComputedStyle(document.documentElement).overflowX === 'hidden',
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Google Ads', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Google Ads' })).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.body.scrollWidth <= innerWidth &&
        getComputedStyle(document.documentElement).overflowX === 'hidden',
    ),
  ).toBe(true);
});

test('gestão cria atendente e primeiro acesso obriga troca de senha', async ({ page, browser }) => {
  await login(page);
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('button', { name: 'Nova atendente', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome da atendente').fill('Atendente E2E');
  await dialog.getByLabel('E-mail de acesso').fill('atendente-e2e@example.test');
  await dialog.getByLabel('Senha temporária').fill('Ab!123');
  await dialog.getByRole('button', { name: 'Confirmar alteração' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Atendente E2E', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'test-results/equipe-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1280, height: 720 });
  const context = await browser.newContext();
  const attendant = await context.newPage();
  try {
    await attendant.goto('/');
    await attendant.getByRole('button', { name: 'Usar e-mail e senha' }).click();
    await attendant.getByLabel('E-mail', { exact: true }).fill('atendente-e2e@example.test');
    await attendant.getByLabel('Senha', { exact: true }).fill('Ab!123');
    await attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
    await expect(
      attendant.getByRole('heading', { name: 'Defina sua senha pessoal' }),
    ).toBeVisible();
    await attendant.getByLabel('Senha atual ou temporária').fill('Ab!123');
    await attendant.getByLabel('Nova senha', { exact: true }).fill('Cd!456');
    await attendant.getByLabel('Confirmar nova senha').fill('Cd!456');
    await attendant.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(
      attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }),
    ).toBeVisible();
    await attendant.getByRole('button', { name: 'Usar e-mail e senha' }).click();
    await attendant.getByLabel('E-mail', { exact: true }).fill('atendente-e2e@example.test');
    await attendant.getByLabel('Senha', { exact: true }).fill('Cd!456');
    await attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
    await expect(attendant.getByRole('heading', { name: 'Meus atendimentos' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('central de distribuição acompanha reservas, histórico e aceite por outra atendente', async ({
  page,
  browser,
}) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Distribuição', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Distribuição' })).toBeVisible();
  await expect(page.locator('.distribution-table tbody tr').first()).toBeVisible();
  await page.getByLabel('Buscar na distribuição').fill('Eduardo Ribeiro');
  const reservation = page
    .locator('.distribution-table tbody tr')
    .filter({ hasText: 'Eduardo Ribeiro' });
  await expect(reservation.locator('.countdown')).toHaveText(/\d{2}:\d{2}/);
  await page.getByRole('button', { name: 'Histórico de Eduardo Ribeiro' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(/Distribuído para/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByLabel('Buscar na distribuição').clear();
  await page
    .getByLabel('Situação dos leads')
    .getByRole('button', { name: /^Bolsão/ })
    .click();
  await expect(page.locator('.distribution-table').getByText('Daniel Rocha')).toBeVisible();
  const response = await page.request.get('/api/v1/distribution/board?state=POOL');
  const lead = (await response.json()).rows.find(
    (r: { name: string }) => r.name === 'Daniel Rocha',
  );
  const context = await browser.newContext();
  try {
    const attendant = await context.newPage();
    await login(attendant, 'vanessa');
    const claim = await attendant.request.post(`/api/v1/opportunities/${lead.id}/claim`, {
      headers: { 'X-Artisti-Client': 'web', 'Idempotency-Key': `e2e-distribution-${Date.now()}` },
      data: { mode: 'pool', expected_version: lead.version },
    });
    expect(claim.status()).toBe(200);
    await expect(page.locator('.distribution-table').getByText('Daniel Rocha')).toHaveCount(0, {
      timeout: 12000,
    });
    await page
      .getByLabel('Situação dos leads')
      .getByRole('button', { name: /^Em atendimento/ })
      .click();
    const assigned = page
      .locator('.distribution-table tbody tr')
      .filter({ hasText: 'Daniel Rocha' });
    await expect(assigned.locator('.distribution-owner')).toContainText('Vanessa');
    await page.getByRole('button', { name: 'Histórico de Daniel Rocha' }).click();
    await expect(dialog.getByText(/Lead assumido por Vanessa/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Fechar janela' }).click();
    await page.screenshot({ path: 'test-results/distribuicao-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('button', { name: 'Configurar rodízio' })).toBeVisible();
    expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.getByRole('button', { name: 'Gerenciar Daniel Rocha' })).toBeVisible();
    await page.screenshot({
      path: 'test-results/distribuicao-mobile.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Configurar rodízio' }).click();
    await expect(dialog.getByLabel('Prazo para aceite')).toHaveValue('10');
    await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  } finally {
    await context.close();
  }
});

test('distribuição aceita consulta lenta e usa a mesma fotografia para equipe e leads', async ({
  page,
}) => {
  await login(page);
  const expected = await (await page.request.get('/api/v1/distribution/board')).json();
  const firstUser = expected.users.find(
    (u: { id: string }) => u.id === expected.rows[0].reserved_to,
  );
  // Simulate the workspace's independent snapshot lagging behind the board.
  await page.route('**/api/v1/workspace', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: { ...body, users: [], settings: { ...body.settings, timeout_minutes: 55 } },
    });
  });
  let calls = 0;
  await page.route('**/api/v1/distribution/board?*', async (route) => {
    calls++;
    const response = await route.fetch();
    await new Promise((resolve) => setTimeout(resolve, 6500));
    await route.fulfill({ response });
  });
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Distribuição', exact: true })
    .click();
  await expect(page.locator('.distribution-table tbody tr').first()).toBeVisible({
    timeout: 12000,
  });
  // React StrictMode can mount twice, but a slow request must finish rather than
  // being restarted by each five-second workspace poll.
  expect(calls).toBeLessThanOrEqual(2);
  await expect(page.locator('.distribution-rule')).toContainText('10 min');
  await expect(
    page.locator('.distribution-table tbody tr').first().locator('.distribution-owner'),
  ).toContainText(firstUser.name);
});

test('distribuição recupera falhas e descarta respostas de filtros anteriores', async ({
  page,
}) => {
  await login(page);
  let unavailable = true;
  let releaseOld!: () => void;
  let completeOld!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldComplete = new Promise<void>((resolve) => {
    completeOld = resolve;
  });
  await page.route('**/api/v1/distribution/board?*', async (route) => {
    if (unavailable) {
      await route.fulfill({ status: 503, json: { message: 'Falha temporária no teste' } });
      return;
    }
    const response = await route.fetch();
    if (new URL(route.request().url()).searchParams.get('search') === 'Eduardo') {
      await gate;
      try {
        await route.fulfill({ response });
      } finally {
        completeOld();
      }
    } else await route.fulfill({ response });
  });
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Distribuição', exact: true })
    .click();
  await expect(page.getByRole('alert')).toContainText('Falha temporária');
  unavailable = false;
  await expect(page.locator('.distribution-table tbody tr').first()).toBeVisible({
    timeout: 12000,
  });
  await expect(page.getByRole('alert')).toHaveCount(0);
  const requested = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('search') === 'Eduardo',
  );
  await page.getByLabel('Buscar na distribuição').fill('Eduardo');
  await requested;
  await page.getByLabel('Buscar na distribuição').fill('Henrique');
  await expect(page.locator('.distribution-contact')).toContainText(['Henrique Alves']);
  releaseOld();
  await oldComplete;
  await expect(page.locator('.distribution-contact')).toContainText(['Henrique Alves']);
});

test('configuração preserva rascunho e mostra conflito dentro da janela', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Distribuição', exact: true })
    .click();
  await page.getByRole('button', { name: 'Configurar rodízio' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Prazo para aceite').fill('15');
  const original = await (await page.request.get('/api/v1/distribution/board')).json();
  const payload = {
    version: original.settings.version,
    timeout_minutes: 11,
    participants: original.users
      .filter((u: { role: string }) => u.role === 'attendant')
      .map((u: { id: string; queue_enabled: boolean }) => ({ id: u.id, enabled: u.queue_enabled })),
  };
  const result = await page.request.patch('/api/v1/distribution/settings', {
    headers: { 'X-Artisti-Client': 'web' },
    data: payload,
  });
  expect(result.status()).toBe(200);
  await expect(page.locator('.distribution-rule')).toContainText('11 min', { timeout: 12000 });
  await expect(dialog.getByLabel('Prazo para aceite')).toHaveValue('15');
  await dialog.getByRole('button', { name: 'Salvar configuração' }).click();
  await expect(dialog.getByRole('alert')).toContainText('configuração mudou');
  expect(
    (await (await page.request.get('/api/v1/distribution/board')).json()).settings.timeout_minutes,
  ).toBe(11);
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByRole('button', { name: 'Configurar rodízio' }).click();
  await expect(dialog.getByLabel('Prazo para aceite')).toHaveValue('11');
  await dialog.getByLabel('Prazo para aceite').fill('10');
  await dialog.getByRole('button', { name: 'Salvar configuração' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.distribution-rule')).toContainText('10 min');
});

test('gestão transfere lead e desativação redistribui os atendimentos', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Rafael Almeida');
  await page.getByRole('button', { name: 'Abrir ficha de Rafael Almeida' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Atribuir / transferir' }).click();
  await dialog.getByLabel('Nova responsável').selectOption({ label: 'Priscila' });
  await dialog.getByLabel('Motivo da transferência').fill('Transferência de teste operacional');
  await dialog.getByRole('button', { name: 'Confirmar atribuição' }).click();
  await dialog.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(dialog.getByText(/Atribuído pela gestão para Priscila/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const member = page
    .locator('.team-list article')
    .filter({ has: page.getByText('Priscila', { exact: true }) });
  await member.getByRole('button', { name: 'Gerenciar' }).click();
  await dialog.getByLabel('Permitir acesso ao CRM').uncheck();
  await dialog
    .getByLabel('Destino dos atendimentos ao desativar')
    .selectOption({ label: 'Vitória' });
  await dialog.getByLabel('Motivo da alteração').fill('Desativação da conta no teste');
  await dialog.getByRole('button', { name: 'Confirmar alteração' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(member.getByText(/Acesso desativado/)).toBeVisible();
});
