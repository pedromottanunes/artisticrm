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

async function mockAudio(page: Page) {
  await page.addInitScript(() => {
    let pulses = 0;
    let allowed = false;
    let latest: TestAudio | undefined;
    window.addEventListener('pointerdown', () => {
      allowed = true;
    });
    Object.defineProperty(window, 'testSoundPulses', { get: () => pulses });
    Object.defineProperty(window, 'interruptTestAudio', {
      value: () => {
        latest!.state = 'interrupted';
        latest!.onstatechange?.();
      },
    });
    class TestAudio {
      state = 'suspended';
      onstatechange: (() => void) | null = null;
      get currentTime() {
        return performance.now() / 1000;
      }
      destination = {};
      constructor() {
        latest = this;
      }
      async resume() {
        if (!allowed) throw new Error('Gesture required');
        this.state = 'running';
        this.onstatechange?.();
      }
      createOscillator() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const oscillator = {
          type: '',
          frequency: { value: 0 },
          connect() {},
          disconnect() {},
          start() {
            pulses++;
          },
          stop(at?: number) {
            clearTimeout(timer);
            timer = setTimeout(
              () => oscillator.onended?.(),
              Math.max(0, (at ?? 0) * 1000 - performance.now()),
            );
          },
          onended: null as null | (() => void),
        };
        return oscillator;
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
}

const pulses = (page: Page) =>
  page.evaluate(() => (window as Window & { testSoundPulses?: number }).testSoundPulses);

async function sendPush(page: Page, userId: string, tag: string) {
  return page.evaluate(
    ({ userId, tag }) =>
      new Promise<boolean>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = (event) => {
          channel.port1.close();
          channel.port2.close();
          resolve(event.data.handled);
        };
        navigator.serviceWorker.dispatchEvent(
          new MessageEvent('message', {
            data: { type: 'artisti-push', userId, tag, soundDeadline: Date.now() + 900 },
            ports: [channel.port2],
          }),
        );
      }),
    { userId, tag },
  );
}

test('gestão móvel: som dos avisos respeita usuário, silêncio e repetição', async ({ page }) => {
  await mockAudio(page);
  const userId = await login(page);
  await page.goto('/#settings');
  const mute = page.getByRole('button', { name: 'Silenciar som no CRM' });
  await expect(mute).toHaveAttribute('aria-pressed', 'true');
  const send = (user: string, tag: string) => sendPush(page, user, tag);
  // Before a gesture, the browser has not unlocked audio.
  await send(userId, 'locked');
  expect(await pulses(page)).toBe(0);
  await expect(page.getByText('Áudio aguardando liberação', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Testar som', exact: true }).click();
  await expect.poll(() => pulses(page)).toBe(12);
  await expect(page.getByText('Áudio preparado', { exact: false })).toBeVisible();
  await page.waitForTimeout(2750); // The alert is deliberately bounded at 2.64s.
  await send('another-user', 'private');
  expect(await pulses(page)).toBe(12);
  await send(userId, 'new-message');
  await expect.poll(() => pulses(page)).toBe(24);
  await send(userId, 'new-message');
  expect(await pulses(page)).toBe(24);
  await mute.click();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(page.getByText('Som silenciado no CRM', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Testar som', exact: true }).click();
  await expect(
    page.getByText('Ative o som no CRM antes de testar.', { exact: true }),
  ).toBeVisible();
  await send(userId, 'muted-message');
  expect(await pulses(page)).toBe(24);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Ativar som no CRM' })).toBeVisible();
  await page.getByRole('button', { name: 'Ativar som no CRM' }).click();
  await send(userId, 'after-reload');
  await expect.poll(() => pulses(page)).toBe(12);
});

test('gestão móvel: retoma áudio interrompido e mostra estado real sem reproduzir avisos antigos', async ({
  page,
}, testInfo) => {
  await mockAudio(page);
  const userId = await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#settings');
  await page.getByRole('button', { name: 'Testar som', exact: true }).click();
  await expect.poll(() => pulses(page)).toBe(12);
  const interrupt = () =>
    page.evaluate(() =>
      (window as Window & { interruptTestAudio: () => void }).interruptTestAudio(),
    );
  await interrupt();
  await expect(page.getByText('Áudio aguardando liberação', { exact: false })).toBeVisible();
  expect(await sendPush(page, userId, 'after-interruption')).toBe(true);
  await expect.poll(() => pulses(page)).toBe(24);
  await interrupt();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('Áudio preparado', { exact: false })).toBeVisible();
  expect(await pulses(page)).toBe(24, 'returning to CRM must not replay the old sound');
  expect(await sendPush(page, userId, 'fresh')).toBe(true);
  await expect.poll(() => pulses(page)).toBe(36);
  expect(await sendPush(page, userId, 'burst')).toBe(true);
  expect(await pulses(page)).toBe(36, 'nearby events cannot stack the 2.64s alerts');
  await page.getByRole('button', { name: 'Testar som', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .locator('.device-options')
    .screenshot({ path: testInfo.outputPath('notification-settings.png') });
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
