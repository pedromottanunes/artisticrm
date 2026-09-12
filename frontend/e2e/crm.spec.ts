import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// Reuse demo sessions across isolated pages; repeated UI login isn't the purpose
// of every regression and would exhaust the real login rate limit for one IP.
const demoSessions = new Map<string, Awaited<ReturnType<BrowserContext['cookies']>>>();

test('push no aparelho: permissão somente por toque, teste e desativação', async ({ page }) => {
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
  const calls: string[] = [];
  await page.addInitScript(() => {
    let permission: NotificationPermission = 'default';
    let active = false;
    const events: string[] = [];
    (window as Window & { pushTestEvents?: string[] }).pushTestEvents = events;
    Object.defineProperty(Notification, 'permission', {
      get: () => permission,
      configurable: true,
    });
    Object.defineProperty(Notification, 'requestPermission', {
      value: async () => {
        events.push('permission');
        permission = 'granted';
        return permission;
      },
      configurable: true,
    });
    const sub = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/browser-test',
      options: { applicationServerKey: new Uint8Array([4, ...Array(64).fill(1)]).buffer },
      toJSON: () => ({
        endpoint: 'https://fcm.googleapis.com/fcm/send/browser-test',
        keys: { p256dh: 'test', auth: 'test' },
      }),
      unsubscribe: async () => {
        active = false;
        events.push('unsubscribe');
        return true;
      },
    };
    const registration = {
      active: {},
      pushManager: {
        getSubscription: async () => (active ? sub : null),
        subscribe: async () => {
          active = true;
          events.push('subscribe');
          return sub;
        },
      },
    };
    Object.defineProperty(navigator.serviceWorker, 'register', { value: async () => registration });
    Object.defineProperty(navigator.serviceWorker, 'getRegistration', {
      value: async () => registration,
    });
    Object.defineProperty(navigator.serviceWorker, 'ready', {
      get: () => Promise.resolve(registration),
    });
  });
  await page.route('**/api/v1/push/config', (route) =>
    route.fulfill({ json: { enabled: true, publicKey } }),
  );
  await page.route('**/api/v1/push/subscriptions', (route) => {
    calls.push(route.request().method());
    return route.fulfill({ json: { ok: true } });
  });
  await page.route('**/api/v1/push/test', (route) => {
    calls.push('test');
    return route.fulfill({ json: { ok: true } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page
    .getByRole('navigation', { name: 'Atalhos de gestão' })
    .getByRole('button', { name: 'Configurações' })
    .click();
  await expect(page.getByRole('button', { name: 'Ativar notificações' })).toBeVisible();
  const events = () =>
    page.evaluate(() => (window as Window & { pushTestEvents: string[] }).pushTestEvents);
  expect(await events()).toEqual([]);
  await page.getByRole('button', { name: 'Ativar notificações' }).click();
  await expect(
    page.getByText('Notificações ativadas neste aparelho', { exact: true }),
  ).toBeVisible();
  expect(await events()).toEqual(['permission', 'subscribe']);
  await page.getByRole('button', { name: 'Testar aviso' }).click();
  await expect(page.getByText('Teste colocado na fila.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Desativar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ativar notificações' })).toBeVisible();
  expect(calls).toEqual(['POST', 'test', 'DELETE']);
  expect(await events()).toEqual(['permission', 'subscribe', 'unsubscribe']);
});

test('gestão móvel: todas as telas pela barra inferior, cartões e formulário com teclado', async ({
  page,
}) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const navigation = page.getByRole('navigation', { name: 'Atalhos de gestão' });
  await expect(navigation).toBeVisible();
  await expect(page.locator('.sidebar')).toBeHidden();
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 844 });
    for (const name of [
      'Visão geral',
      'Distribuição',
      'Leads',
      'Funil',
      'Agenda',
      'Contratos',
      'Configurações',
    ]) {
      const button = navigation.getByRole('button', { name: new RegExp(`^${name}`) });
      await button.click();
      await expect(button).toHaveAttribute('aria-current', 'page');
      expect(
        await page.evaluate(() => document.body.scrollWidth <= innerWidth),
        `${name} at ${width}`,
      ).toBe(true);
      expect(
        await navigation.evaluate((el) =>
          Math.abs(el.getBoundingClientRect().bottom - innerHeight),
        ),
      ).toBeLessThan(2);
      const box = await button.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await expect(navigation.getByRole('button', { name: 'Meta Ads' })).toHaveCount(0);
  await expect(navigation.getByRole('button', { name: 'Google Ads' })).toHaveCount(0);
  await expect(page.locator('.sidebar .workspace-label')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.getByRole('button', { name: /^Leads/ }).click();
  await expect(page.locator('.leads-table tbody tr').first()).toBeVisible();
  expect(
    (await page.getByLabel('Buscar nome ou telefone').boundingBox())!.height,
  ).toBeLessThanOrEqual(60);
  expect(
    await page
      .locator('.leads-table tbody tr')
      .first()
      .evaluate((el) => getComputedStyle(el).display),
  ).toBe('grid');
  await page.screenshot({ path: 'test-results/mobile-leads-cards.png', fullPage: true });
  await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do contato').fill('Teste Responsivo');
  expect(
    await dialog
      .getByLabel('Nome do contato')
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await page.setViewportSize({ width: 390, height: 410 });
  await expect(dialog.getByRole('button', { name: 'Cadastrar e distribuir' })).toBeVisible();
  await dialog.getByLabel('WhatsApp com país e DDD').fill('5548999990000');
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.height).toBeLessThanOrEqual(410);
  await page.screenshot({ path: 'test-results/mobile-form-keyboard.png' });
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await navigation.getByRole('button', { name: 'Configurações', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Este aparelho' })).toBeVisible();
  await page.getByRole('button', { name: 'Sair e acessar outro perfil' }).click();
  await expect(page.getByRole('button', { name: 'Entrar no espaço de trabalho' })).toBeVisible();
});

test('exclusão permanente: confirmação explícita e atualização imediata no celular', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const name = `Exclusão E2E ${Date.now()}`;
  const created = await page.request.post('/api/v1/opportunities', {
    headers: {
      'X-Artisti-Client': 'web',
      'Idempotency-Key': `e2e-delete-${Date.now()}`,
    },
    data: {
      name,
      phone: `554897${String(Date.now()).slice(-7)}`,
      interest: 'Teste isolado',
      unit: 'Teste',
      source: 'Cadastro manual',
    },
  });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.reload();
  await page
    .getByRole('navigation', { name: 'Atalhos de gestão' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  const row = page.locator('.leads-table tbody tr').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: `Abrir ficha de ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Excluir lead' }).click();
  const permanent = dialog.getByRole('button', { name: 'Excluir permanentemente' });
  await expect(permanent).toBeDisabled();
  await dialog.getByLabel('Digite EXCLUIR para confirmar').fill('EXCLUIR');
  await expect(permanent).toBeEnabled();
  await permanent.click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText('Lead excluído permanentemente. Não há opção de desfazer.'),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  expect((await page.request.get(`/api/v1/opportunities/${id}`)).status()).toBe(404);
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
});

test('PWA: manifesto, ícones, abertura por aviso e cache sem dados privados', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'vanessa');
  const manifestResponse = await page.request.get('/manifest.webmanifest');
  const manifest = await manifestResponse.json();
  expect(manifest.display).toBe('standalone');
  for (const icon of manifest.icons) expect((await page.request.get(icon.src)).ok()).toBe(true);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.goto('/#pool');
  await expect(page.getByRole('heading', { level: 1, name: 'Bolsão' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Atalhos de atendimento' })
    .getByRole('button', { name: 'Meu perfil' })
    .click();
  await expect(page.getByRole('heading', { name: 'Este aparelho' })).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-device-settings.png', fullPage: true });
  const cachedPaths = await page.evaluate(async () => {
    const result: string[] = [];
    for (const name of await caches.keys())
      for (const request of await (await caches.open(name)).keys())
        result.push(new URL(request.url).pathname);
    return result;
  });
  expect(cachedPaths).toContain('/offline.html');
  expect(cachedPaths.every((path) => !path.startsWith('/api/') && path !== '/')).toBe(true);
});

test('PWA: queda de conexão mostra página pública e recupera o acesso', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName === 'webkit' && process.platform === 'win32',
    'WebKit Windows falha em reload offline até com service worker mínimo sem cache; validar no iPhone real.',
  );
  await login(page, 'vanessa');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await page.goto('/#settings');
  await expect(page.getByRole('heading', { level: 1, name: 'Meu perfil' })).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: /conexão/i })).toBeVisible();
  await expect(page.locator('.lead-card')).toHaveCount(0);
  await context.setOffline(false);
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Meu perfil' })).toBeVisible();
});

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

test('design operacional: quadro, lista e cartões responsivos preservam os mesmos leads', async ({
  page,
}) => {
  await login(page);
  await page.goto('/#distribution');
  await expect(page.locator('.operational-card').first()).toBeVisible();
  const firstName = await page.locator('.operational-contact strong').first().innerText();
  const cardCount = await page.locator('.operational-card').count();
  await expect(page.getByRole('button', { name: 'Quadro', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Lista', exact: true }).click();
  await expect(page.locator('.distribution-table tbody tr')).toHaveCount(cardCount);
  await expect(page.locator('.distribution-table')).toContainText(firstName);
  await page.getByRole('button', { name: 'Quadro', exact: true }).click();
  await expect(page.locator('.operational-card')).toHaveCount(cardCount);
  for (const width of [320, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    const overflow = await page
      .locator('.operational-card, .operational-lane, .distribution-results, .distribution-history')
      .evaluateAll((elements) =>
        elements
          .filter((element) => {
            const box = element.getBoundingClientRect();
            return box.left < 0 || box.right > innerWidth + 1;
          })
          .map((element) => element.className),
      );
    expect(overflow, `overflow at ${width}px`).toEqual([]);
    if (width === 390) {
      const summary = page.locator('.distribution-overview > summary');
      await expect(page.getByLabel('Resumo da distribuição')).not.toBeVisible();
      await summary.click();
      await expect(page.getByLabel('Resumo da distribuição')).toBeVisible();
      await summary.click();
      await expect(page.getByLabel('Resumo da distribuição')).not.toBeVisible();
      await page.evaluate(() => window.scrollTo(0, 0));
    }
    if (width === 390 || width === 1920) {
      await page.screenshot({
        path: `test-results/artisti-operacional-${width}.png`,
        fullPage: true,
      });
    }
    if (width <= 1024)
      await expect(page.getByRole('navigation', { name: 'Atalhos de gestão' })).toBeVisible();
  }
  await page.getByRole('button', { name: `Gerenciar ${firstName}`, exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('distribuição mantém a estrutura visível enquanto troca os resultados', async ({ page }) => {
  await login(page);
  await page.goto('/#distribution');
  await expect(page.locator('.operational-card').first()).toBeVisible();

  const previousName = await page.locator('.operational-contact strong').first().innerText();
  const previousCardCount = await page.locator('.operational-card').count();
  await page.locator('.workspace-intro').evaluate((element) => {
    element.setAttribute('data-stability-check', 'preserved');
  });

  let releaseResults!: () => void;
  const resultsGate = new Promise<void>((resolve) => {
    releaseResults = resolve;
  });
  await page.route('**/api/v1/distribution/board?*', async (route) => {
    const requestedState = new URL(route.request().url()).searchParams.get('state');
    if (requestedState !== 'POOL') {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await resultsGate;
    await route.fulfill({ response });
  });

  const requested = page.waitForRequest(
    (request) => new URL(request.url()).searchParams.get('state') === 'POOL',
  );
  await page
    .getByLabel('Situação dos leads')
    .getByRole('button', { name: /^Bolsão/ })
    .click();
  await requested;

  await expect(page.getByText('Atualizando resultados…', { exact: true })).toBeVisible();
  await expect(page.locator('.workspace-intro')).toHaveAttribute(
    'data-stability-check',
    'preserved',
  );
  await expect(page.locator('.operational-card')).toHaveCount(previousCardCount);
  await expect(page.locator('.operational-contact strong').first()).toHaveText(previousName);

  releaseResults();
  await expect(page.getByText('Atualizando resultados…', { exact: true })).toHaveCount(0);
  await expect(page.locator('.operational-lane')).toHaveAttribute('aria-label', 'Bolsão');
  await expect(page.locator('.operational-card').first()).toBeVisible();
});

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
  expect(layout.tableCanScrollInternally).toBe(false); // Mobile rows are now readable cards.
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
  await expect(page.getByRole('button', { name: 'Meta Ads', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Google Ads', exact: true })).toHaveCount(0);
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
  await page
    .getByRole('navigation', { name: 'Atalhos de gestão' })
    .getByRole('button', { name: 'Contratos', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Contratos' })).toBeVisible();
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
  await expect(page.locator('.operational-card').first()).toBeVisible();
  await page.getByLabel('Buscar na distribuição').fill('Eduardo Ribeiro');
  const reservation = page.locator('.operational-card').filter({ hasText: 'Eduardo Ribeiro' });
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
  await expect(page.locator('.operational-columns').getByText('Daniel Rocha')).toBeVisible();
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
    await expect(page.locator('.operational-columns').getByText('Daniel Rocha')).toHaveCount(0, {
      timeout: 12000,
    });
    await page
      .getByLabel('Situação dos leads')
      .getByRole('button', { name: /^Em atendimento/ })
      .click();
    const assigned = page.locator('.operational-card').filter({ hasText: 'Daniel Rocha' });
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
  await expect(page.locator('.operational-card').first()).toBeVisible({
    timeout: 12000,
  });
  // React StrictMode can mount twice, but a slow request must finish rather than
  // being restarted by each five-second workspace poll.
  expect(calls).toBeLessThanOrEqual(2);
  await expect(page.locator('.distribution-rule')).toContainText('10 min');
  await expect(
    page.locator('.operational-card').first().locator('.distribution-owner'),
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
  await expect(page.locator('.operational-card').first()).toBeVisible({
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
