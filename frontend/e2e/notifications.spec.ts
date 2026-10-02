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
  await expect.poll(pulses).toBe(3);
  await page.waitForTimeout(1150); // Wait for the intentional overlapping-sound guard.
  await send('another-user', 'private');
  expect(await pulses()).toBe(3);
  await send(userId, 'new-message');
  await expect.poll(pulses).toBe(6);
  await send(userId, 'new-message');
  expect(await pulses()).toBe(6);
  await mute.click();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await page.waitForTimeout(1150);
  await send(userId, 'muted-message');
  expect(await pulses()).toBe(6);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toBeVisible();
  await page.getByRole('button', { name: 'Ativar som no CRM' }).click();
  await send(userId, 'after-reload');
  await expect.poll(pulses).toBe(3);
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
