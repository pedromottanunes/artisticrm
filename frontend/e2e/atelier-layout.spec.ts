import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function login(page: Page, profile: 'cadu' | 'vanessa') {
  const response = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBe(true);
  return (await page.request.get('/api/v1/workspace')).json();
}

for (const profile of ['cadu', 'vanessa'] as const) {
  for (const width of [320, 390]) {
    test(`Atelier: cabeçalho compacto em todas as áreas de ${profile} (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await login(page, profile);
      const sections =
        profile === 'cadu'
          ? [
              ['central', 'Central de atendimentos'],
              ['inbox', 'Conversas'],
              ['comments', 'Comentários'],
              ['pipeline', 'Funil de vendas'],
              ['lists', 'Listas'],
              ['agenda', 'Agenda'],
              ['reports', 'Relatórios'],
              ['contracts', 'Contratos'],
              ['settings', 'Configurações'],
            ]
          : [
              ['mine', 'Meus atendimentos'],
              ['lists', 'Listas'],
              ['inbox', 'Conversas'],
              ['pool', 'Bolsão'],
              ['comments', 'Bolsão'],
              ['agenda', 'Agenda'],
              ['shortcuts', 'Atalhos'],
              ['settings', 'Meu perfil'],
            ];
      for (const [section, title] of sections) {
        await page.goto(`/#${section}`);
        await expect(
          page.getByRole('heading', { level: 1, name: title, exact: true }),
        ).toBeVisible();
        if (profile === 'vanessa')
          await expect(page.locator('.consultant-queue-position')).toBeVisible();
        const layout = await page.locator('.topbar').evaluate((header) => {
          const bounds = header.getBoundingClientRect();
          const logo = header.querySelector('.mobile-header-logo')!.getBoundingClientRect();
          const heading = header.querySelector<HTMLElement>('h1')!;
          const title = heading.getBoundingClientRect();
          const actions = header.querySelector('.topbar-right')!.getBoundingClientRect();
          const queue = header.querySelector('.consultant-queue-position')?.getBoundingClientRect();
          return {
            height: bounds.height,
            logoGap: title.left - logo.right,
            actionsGap: actions.left - title.right,
            titleAligned: Math.abs(title.top + title.height / 2 - (logo.top + logo.height / 2)),
            titleCentered: Math.abs(title.left + title.width / 2 - (logo.right + actions.left) / 2),
            titleClipped: heading.scrollWidth > heading.clientWidth + 1,
            buttonsAccessible: [
              ...header.querySelectorAll('.header-primary-action, .topbar-right > .icon-button'),
            ].every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.width >= 44 &&
                box.height >= 44 &&
                box.right <= bounds.right &&
                box.bottom <= bounds.bottom
              );
            }),
            queueFits:
              !queue ||
              (queue.top >= title.bottom &&
                queue.bottom <= bounds.bottom &&
                queue.left >= bounds.left &&
                queue.right <= bounds.right),
          };
        });
        expect(layout.height, `${section}: altura`).toBeLessThanOrEqual(
          profile === 'cadu' ? 84 : 112,
        );
        expect(layout.logoGap, `${section}: logo e título`).toBeGreaterThanOrEqual(7);
        expect(layout.actionsGap, `${section}: título e botões`).toBeGreaterThanOrEqual(7);
        expect(layout.titleAligned, `${section}: alinhamento vertical`).toBeLessThan(2);
        expect(layout.titleCentered, `${section}: título centralizado`).toBeLessThan(2);
        expect(layout.titleClipped, `${section}: título completo`).toBe(false);
        expect(layout.buttonsAccessible, `${section}: botões acessíveis`).toBe(true);
        expect(layout.queueFits, `${section}: indicador de vez`).toBe(true);
        if (section === 'central' || section === 'settings' || section === 'mine') {
          await page.screenshot({
            path: test.info().outputPath(`${section}.png`),
            fullPage: false,
          });
        }
      }
    });
  }
}

test('Atelier: menu completo continua acessível em notebook de pouca altura', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  await login(page, 'cadu');
  await page.goto('/#central');
  const settings = page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Configurações' });
  await settings.click();
  await expect(page.locator('.settings-section-toggle')).toHaveCount(6);
  const bounds = (await settings.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(600);
  expect(
    await page.locator('.sidebar nav').evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
});

for (const width of [320, 390, 768]) {
  test(`Atelier: nome, ações e resposta do chat ficam acessíveis (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const { user } = await login(page, 'vanessa');
    const conversation = {
      id: 'atelier-chat',
      opportunity_id: 'atelier-lead',
      contact_name: 'Rafael Almeida de Oliveira',
      channel: 'instagram',
      instagram_username: 'rafael.almeida',
      profile_picture_url: '',
      state: 'CLAIMED',
      owner_id: user.id,
      reserved_to: null,
      last_message_at: '2026-11-02T12:00:00Z',
      unread: false,
      can_send: true,
      messaging_mode: 'direct',
    };
    await page.route('**/api/v1/conversations?*', (route) =>
      route.fulfill({ json: { configured: true, conversations: [conversation] } }),
    );
    await page.route('**/api/v1/conversations/*/read', (route) =>
      route.fulfill({ json: { read: true } }),
    );
    await page.route('**/api/v1/conversations/*/messages*', (route) =>
      route.fulfill({
        json: {
          conversation_id: conversation.id,
          opportunity_id: conversation.opportunity_id,
          can_send: true,
          messaging_mode: 'direct',
          has_more: false,
          last_message_at: conversation.last_message_at,
          messages: [
            {
              id: 'atelier-message',
              direction: 'inbound',
              type: 'text',
              text: 'Quero agendar uma avaliação.',
              attachments: [],
              status: 'received',
              created_at: conversation.last_message_at,
            },
          ],
        },
      }),
    );
    await page.goto('/#inbox');
    if (width <= 760)
      await page.getByRole('button', { name: conversation.contact_name, exact: true }).click();
    const heading = page.locator('.thread-header h2');
    await expect(heading).toHaveText(conversation.contact_name);
    const draft = page.locator('.thread-composer textarea');
    await draft.fill('Olá, Rafael! Qual dia fica melhor?');
    await expect(
      page.locator('.thread-composer').getByRole('button', { name: 'Enviar', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Silenciar notificações deste lead' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir ficha do lead' })).toBeVisible();
    if (width <= 760) {
      // Check actual bounds: toBeVisible alone would miss a composer behind navigation.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const header = document.querySelector('.topbar')!.getBoundingClientRect();
            const thread = document.querySelector('.thread-header')!.getBoundingClientRect();
            const composer = document.querySelector('.thread-composer')!.getBoundingClientRect();
            const nav = document.querySelector('.mobile-bottom-nav')!.getBoundingClientRect();
            return thread.top >= header.bottom - 1 && composer.bottom <= nav.top + 1;
          }),
        )
        .toBe(true);
    }
    const clipped = await heading.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
    await page.screenshot({ path: `test-results/atelier-chat-${width}.png`, fullPage: true });
  });
}
