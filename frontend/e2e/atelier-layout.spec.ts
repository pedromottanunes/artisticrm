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
