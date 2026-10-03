import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('slow polling stays single-flight and unchanged snapshots retain the conversation', async ({
  page,
}) => {
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(login.ok()).toBeTruthy();
  const revision = 'a'.repeat(64);
  let lists = 0;
  let histories = 0;
  let hold = true;
  let release: (() => void) | undefined;
  let latest = '2026-10-02T12:00:00Z';
  let pendingSend = false;
  let sent = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/conversations?*', async (route) => {
    lists++;
    const requestedRevision = new URL(route.request().url()).searchParams.get('revision');
    if (requestedRevision && hold) {
      expect(requestedRevision).toBe(revision);
      hold = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    if (requestedRevision && latest === '2026-10-02T12:00:00Z')
      return route.fulfill({ json: { unchanged: true, revision } });
    return route.fulfill({
      json: {
        configured: true,
        revision,
        conversations: [
          {
            id: 'conversation-test',
            opportunity_id: 'lead-test',
            contact_name: 'Conversa estável',
            instagram_username: '',
            profile_picture_url: '',
            state: 'CLAIMED',
            owner_id: 'fixture',
            last_message_at: latest,
            can_send: true,
            messaging_mode: 'direct',
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  await page.route('**/api/v1/conversations/*/messages*', (route) => {
    histories++;
    return route.fulfill({
      json: {
        conversation_id: 'conversation-test',
        opportunity_id: 'lead-test',
        can_send: true,
        last_message_at: latest,
        has_more: false,
        messaging_mode: 'direct',
        messages: [
          {
            id: `message-${histories}`,
            direction: pendingSend ? 'outbound' : 'inbound',
            type: 'text',
            text: latest === '2026-10-02T12:00:00Z' ? 'Olá, teste' : 'Mensagem nova',
            attachments: [],
            status: pendingSend ? (sent ? 'sent' : 'sending') : 'received',
            created_at: latest,
          },
        ],
      },
    });
  });
  await page.clock.install();
  await page.goto('/#inbox');
  await expect(page.getByText('Olá, teste', { exact: true })).toBeVisible();
  const initialLists = lists;
  const initialHistories = histories;
  await page.clock.runFor(5_100);
  await expect.poll(() => lists).toBe(initialLists + 1);
  await page.clock.runFor(10_000);
  expect(lists).toBe(initialLists + 1);
  const response = page.waitForResponse((response) =>
    response.url().includes(`revision=${revision}`),
  );
  release!();
  await (await response).finished();
  // Wait for the pending response to reach the browser before advancing its clock.
  await expect(page.locator('.thread-header')).toContainText('Conversa estável');
  await page.clock.runFor(5_000);
  await expect.poll(() => lists).toBe(initialLists + 2);
  expect(histories).toBe(initialHistories);
  latest = '2026-10-02T12:00:01Z';
  await page.clock.runFor(5_000);
  await expect(page.getByText('Mensagem nova', { exact: true })).toBeVisible();
  expect(histories).toBe(initialHistories + 1);
  pendingSend = true;
  await page.getByRole('button', { name: 'Atualizar conversas' }).click();
  await expect(page.locator('.thread-message')).toContainText('sending');
  const beforeStatusRefresh = histories;
  sent = true;
  await page.clock.runFor(20_000);
  await expect(page.locator('.thread-message')).toContainText('sent');
  expect(histories).toBe(beforeStatusRefresh + 1);
  expect(errors).toEqual([]);
});
