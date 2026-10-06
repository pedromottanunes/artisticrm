import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function login(page: Page) {
  const result = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(result.ok()).toBe(true);
  return (await (await page.request.get('/api/v1/workspace')).json()).user.id as string;
}

test('gestão móvel: som dos avisos respeita usuário, silêncio e repetição', async ({ page }) => {
  await page.addInitScript(() => {
    let pulses = 0;
    Object.defineProperty(window, 'testSoundPulses', { get: () => pulses });
    class TestAudio {
      state = 'suspended';
      currentTime = 0;
      destination = {};
      async resume() {
        this.state = 'running';
      }
      createOscillator() {
        return {
          type: '',
          frequency: { value: 0 },
          connect() {},
          disconnect() {},
          start() {
            pulses++;
          },
          stop() {},
          onended: null,
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, linearRampToValueAtTime() {} },
          connect() {},
          disconnect() {},
        };
      }
    }
    Object.defineProperty(window, 'AudioContext', { value: TestAudio });
  });
  const userId = await login(page);
  await page.goto('/#settings');
  const mute = page.getByRole('button', { name: 'Silenciar som no CRM' });
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  const send = async (user: string, tag: string) =>
    page.evaluate(
      ({ user, tag }) => {
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'artisti-push', userId: user, tag },
          }),
        );
      },
      { user, tag },
    );
  const pulses = () =>
    page.evaluate(() => (window as Window & { testSoundPulses?: number }).testSoundPulses);
  // Before a gesture, the browser has not unlocked audio.
  await send(userId, 'locked');
  expect(await pulses()).toBe(0);
  await page.getByRole('button', { name: 'Testar som', exact: true }).click();
  await expect.poll(pulses).toBe(4);
  await page.waitForTimeout(1150); // Wait for the intentional overlapping-sound guard.
  await send('another-user', 'private');
  expect(await pulses()).toBe(4);
  await send(userId, 'new-message');
  await expect.poll(pulses).toBe(8);
  await send(userId, 'new-message');
  expect(await pulses()).toBe(8);
  await mute.click();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.waitForTimeout(1150);
  await send(userId, 'muted-message');
  expect(await pulses()).toBe(8);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toBeVisible();
  await page.getByRole('button', { name: 'Ativar som no CRM' }).click();
  await send(userId, 'after-reload');
  await expect.poll(pulses).toBe(4);
});

test('gestão móvel: aviso de mensagem abre a conversa indicada no link', async ({ page }) => {
  await login(page);
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.route('**/api/v1/conversations?*', (route) =>
    route.fulfill({
      json: {
        configured: true,
        conversations: [
          { id: 'wrong', opportunity_id: 'other', contact_name: 'Outro lead' },
          { id: 'target', opportunity_id: id, contact_name: 'Lead do aviso' },
        ].map((item) => ({
          ...item,
          last_message_at: '2026-10-01T12:00:00Z',
          state: 'CLAIMED',
          owner_id: 'user',
          can_send: true,
        })),
      },
    }),
  );
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  await page.route('**/api/v1/conversations/*/messages*', (route) =>
    route.fulfill({
      json: {
        conversation_id: 'target',
        opportunity_id: id,
        can_send: true,
        last_message_at: '2026-10-01T12:00:00Z',
        has_more: false,
        messages: [
          {
            id: 'message',
            text: 'Mensagem do aviso',
            type: 'text',
            direction: 'inbound',
            status: 'received',
            created_at: '2026-10-01T12:00:00Z',
            attachments: [],
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#inbox?lead=${id}`);
  await expect(page.locator('.inbox-thread')).toContainText('Lead do aviso');
  await expect(page.getByText('Mensagem do aviso', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Mensagem para o Instagram')).toBeVisible();
});

test('consultor silencia e reativa os avisos de um lead pelo chat', async ({ page }) => {
  const userId = await login(page);
  const opportunityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let muted = false;
  const changes: boolean[] = [];
  await page.route('**/api/v1/conversations?*', (route) =>
    route.fulfill({
      json: {
        configured: true,
        conversations: [
          {
            id: 'conversation-muted-lead',
            opportunity_id: opportunityId,
            contact_name: 'Perfil com propaganda',
            instagram_username: 'propaganda',
            profile_picture_url: '',
            state: 'CLAIMED',
            owner_id: userId,
            reserved_to: null,
            last_message_at: '2026-10-05T12:00:00Z',
            unread: true,
            notifications_muted: muted,
            can_send: true,
            messaging_mode: 'direct',
          },
        ],
      },
    }),
  );
  await page.route('**/api/v1/conversations/*/notifications', async (route) => {
    const body = route.request().postDataJSON() as { muted: boolean };
    muted = body.muted;
    changes.push(muted);
    return route.fulfill({ json: { notifications_muted: muted } });
  });
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  await page.route('**/api/v1/conversations/*/messages*', (route) =>
    route.fulfill({
      json: {
        conversation_id: 'conversation-muted-lead',
        opportunity_id: opportunityId,
        can_send: true,
        last_message_at: '2026-10-05T12:00:00Z',
        has_more: false,
        messaging_mode: 'direct',
        messages: [
          {
            id: 'message-propaganda',
            text: 'Mensagem repetida',
            type: 'text',
            direction: 'inbound',
            status: 'received',
            created_at: '2026-10-05T12:00:00Z',
            attachments: [],
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/#inbox?lead=${opportunityId}`);
  const silence = page.getByRole('button', { name: 'Silenciar notificações deste lead' });
  await expect(silence).toBeVisible();
  await silence.click();
  const reactivate = page.getByRole('button', { name: 'Reativar notificações deste lead' });
  await expect(reactivate).toBeVisible();
  await expect(
    page.getByText('Notificações deste lead silenciadas.', { exact: true }),
  ).toBeVisible();
  await reactivate.click();
  await expect(
    page.getByRole('button', { name: 'Silenciar notificações deste lead' }),
  ).toBeVisible();
  expect(changes).toEqual([true, false]);
});
