import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1280]) {
  test(`comment pool opens the assigned chat and waits for a reply (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const id = '11111111-1111-4111-8111-111111111111';
    const conversation = '22222222-2222-4222-8222-222222222222';
    const lead = '33333333-3333-4333-8333-333333333333';
    let claimed = false;
    let sent = false;
    let posts = 0;
    const created = new Date().toISOString();
    await page.route('**/api/v1/pool/counts', (route) =>
      route.fulfill({ json: { leads: 2, comments: claimed ? 0 : 1 } }),
    );
    await page.route('**/api/v1/instagram/comments**', async (route) => {
      if (route.request().method() === 'POST') {
        expect(route.request().postDataJSON()).toEqual({ expected_version: 1 });
        claimed = true;
        return route.fulfill({ json: { opportunity_id: lead, conversation_id: conversation } });
      }
      return route.fulfill({
        json: {
          configured: true,
          next_cursor: null,
          comments: claimed
            ? []
            : [
                {
                  id,
                  username: 'cliente.teste',
                  text: 'Como funciona a avaliação?',
                  permalink: '',
                  thumbnail_url: '',
                  created_at: created,
                  reply_deadline_at: new Date(Date.now() + 86400_000).toISOString(),
                  version: 1,
                  comment_count: 2,
                },
              ],
        },
      });
    });
    await page.route('**/api/v1/conversations?*', (route) =>
      route.fulfill({
        json: {
          configured: true,
          conversations: claimed
            ? [
                {
                  id: conversation,
                  opportunity_id: lead,
                  contact_name: 'cliente.teste',
                  instagram_username: 'cliente.teste',
                  profile_picture_url: '',
                  state: 'CLAIMED',
                  owner_id: 'fixture',
                  last_message_at: created,
                  can_send: !sent,
                  messaging_mode: sent ? 'waiting_reply' : 'private_reply',
                },
              ]
            : [],
        },
      }),
    );
    await page.route('**/api/v1/conversations/*/read', (route) =>
      route.fulfill({ json: { read: true } }),
    );
    await page.route('**/api/v1/conversations/*/messages*', (route) => {
      if (route.request().method() === 'POST') {
        sent = true;
        posts++;
        return route.fulfill({ json: { status: 'sent' } });
      }
      return route.fulfill({
        json: {
          conversation_id: conversation,
          opportunity_id: lead,
          last_message_at: created,
          can_send: !sent,
          messaging_mode: sent ? 'waiting_reply' : 'private_reply',
          has_more: false,
          messages: [
            {
              id: 'comment-context',
              direction: 'inbound',
              type: 'instagram_comment',
              text: 'Como funciona a avaliação?',
              attachments: [],
              status: 'received',
              created_at: created,
            },
          ],
        },
      });
    });
    await page.goto('/#pool');
    await expect(
      page.locator(
        width < 720 ? '.mobile-nav-icon .pool-alert-badge' : '.nav-item .pool-alert-badge',
      ),
    ).toHaveText('3');
    const poolTabs = page.getByRole('navigation', { name: 'Tipo de bolsão' });
    await expect(
      poolTabs.getByRole('button', { name: /^Leads/ }).locator('.pool-alert-badge'),
    ).toHaveText('2');
    await expect(
      poolTabs.getByRole('button', { name: /^Comentários/ }).locator('.pool-alert-badge'),
    ).toHaveText('1');
    await page
      .getByRole('navigation', { name: 'Tipo de bolsão' })
      .getByRole('button', { name: 'Comentários' })
      .click();
    await expect(page.getByText('Como funciona a avaliação?')).toBeVisible();
    await expect(page.getByText('2 comentários')).toBeVisible();
    await expect(page.locator('.comment-card')).toHaveCount(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.getByRole('button', { name: 'Assumir e conversar' }).click();
    await expect(page.getByText('Comentário na publicação')).toBeVisible();
    await expect(page.getByText('Primeira mensagem privada.', { exact: false })).toBeVisible();
    const composer = page.getByLabel('Mensagem para o Instagram');
    await expect(composer).toBeVisible();
    await composer.fill('Olá! Posso explicar como funciona?');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(page.getByText('Aguardando o lead responder no Instagram.')).toBeVisible();
    await expect(composer).toHaveCount(0);
    expect(posts).toBe(1);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  });
}
