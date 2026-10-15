import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1280]) {
  test(`Messenger e Instagram compartilham o chat sem misturar rascunhos (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBe(true);
    const { user } = await (await page.request.get('/api/v1/workspace')).json();
    const now = new Date().toISOString();
    const channels = ['messenger', 'instagram'];
    const conversations = channels.map((channel, index) => ({
      id: `conversation-${channel}`,
      opportunity_id: `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa${index}`,
      channel,
      contact_name: channel === 'messenger' ? 'Contato Messenger' : 'Contato Instagram',
      state: 'CLAIMED',
      owner_id: user.id,
      last_message_at: now,
      can_send: true,
      unread: false,
      messaging_mode: 'direct',
    }));
    const sent: Array<{ conversation: string; text: string; key?: string }> = [];
    await page.route('**/api/v1/conversations?*', (route) =>
      route.fulfill({ json: { configured: true, conversations } }),
    );
    await page.route('**/api/v1/conversations/*/read', (route) =>
      route.fulfill({ json: { read: true } }),
    );
    // Every chat request is intercepted. This test never sends to a real provider.
    await page.route('**/api/v1/conversations/*/messages*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      const conversation = conversations.find((item) => item.id === id)!;
      if (route.request().method() === 'POST') {
        sent.push({
          conversation: id,
          text: route.request().postDataJSON().text,
          key: route.request().headers()['idempotency-key'],
        });
        return route.fulfill({ json: { id: 'synthetic-outbound', status: 'sent' } });
      }
      return route.fulfill({
        json: {
          conversation_id: id,
          opportunity_id: conversation.opportunity_id,
          can_send: true,
          messaging_mode: 'direct',
          last_message_at: now,
          has_more: false,
          messages: [
            {
              id: `message-${id}`,
              direction: 'inbound',
              type: 'text',
              text: `Histórico ${conversation.channel}`,
              attachments: [],
              status: 'received',
              created_at: now,
            },
          ],
        },
      });
    });
    await page.goto(`/#inbox?lead=${conversations[0].opportunity_id}`);
    await expect(page.getByText('Histórico messenger', { exact: true })).toBeVisible();
    const messenger = page.getByLabel('Mensagem para o Messenger');
    await messenger.fill('Rascunho Messenger');
    if (width < 720) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    await expect(page.getByText('Facebook Messenger', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Contato Instagram', exact: true }).click();
    const instagram = page.getByLabel('Mensagem para o Instagram');
    await expect(instagram).toHaveValue('');
    await instagram.fill('Rascunho Instagram');
    if (width < 720) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    await page.getByRole('button', { name: 'Contato Messenger', exact: true }).click();
    await expect(messenger).toHaveValue('Rascunho Messenger');
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect(messenger).toHaveValue('');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      conversation: 'conversation-messenger',
      text: 'Rascunho Messenger',
    });
    expect(sent[0].key?.length).toBeGreaterThanOrEqual(8);
    if (width < 720) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    await page.getByRole('button', { name: 'Contato Instagram', exact: true }).click();
    await expect(instagram).toHaveValue('Rascunho Instagram');
  });
}
