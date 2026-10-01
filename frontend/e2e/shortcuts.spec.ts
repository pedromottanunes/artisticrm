import { test, expect, type Page } from '@playwright/test';

// Conversation fixtures must intercept every request, including in WebKit.
// PWA behavior is covered by its own tests.
test.use({ serviceWorkers: 'block' });

const headers = { 'X-Artisti-Client': 'web' };
const message = 'Olá! Vamos agendar sua avaliação?';

async function login(page: Page) {
  const result = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(result.ok()).toBe(true);
}

async function createShortcut(page: Page, name: string) {
  const result = await page.request.post('/api/v1/shortcuts', {
    headers,
    data: { id: crypto.randomUUID(), name, body: message },
  });
  expect(result.ok()).toBe(true);
  return (await result.json()).shortcut as { id: string; version: number };
}

async function chat(page: Page) {
  const conversations = ['Ana', 'Bruna'].map((name, index) => ({
    id: `conversation-${index}`,
    opportunity_id: `opportunity-${index}`,
    contact_name: name,
    instagram_username: name.toLowerCase(),
    profile_picture_url: '',
    state: 'CLAIMED',
    owner_id: 'test-user',
    reserved_to: null,
    last_message_at: '2026-09-23T15:03:00.000Z',
    can_send: true,
  }));
  await page.route('**/api/v1/conversations?*', (route) =>
    route.fulfill({ json: { configured: true, conversations } }),
  );
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  await page.route('**/api/v1/conversations/*/messages*', async (route) => {
    // No real message is ever sent by this fixture.
    if (route.request().method() === 'POST') return route.fulfill({ json: { status: 'sent' } });
    const id = new URL(route.request().url()).pathname.split('/')[4];
    return route.fulfill({
      json: {
        conversation_id: id,
        opportunity_id: `opportunity-${id.at(-1)}`,
        can_send: true,
        last_message_at: conversations[0].last_message_at,
        has_more: false,
        messages: [
          {
            id: `message-${id}`,
            direction: 'inbound',
            type: 'text',
            text: `Histórico ${id}`,
            attachments: [],
            status: 'received',
            created_at: conversations[0].last_message_at,
          },
        ],
      },
    });
  });
  await page.goto('/#inbox');
  await page.locator('.inbox-conversations').getByRole('button', { name: /Ana/ }).click();
  await expect(page.getByLabel('Mensagem para o Instagram')).toBeVisible();
}

test('atalhos: resposta perdida não duplica cadastro nem edição', async ({ page }) => {
  await login(page);
  let loseCreate = true;
  let loseUpdate = true;
  const ids: string[] = [];
  await page.route('**/api/v1/shortcuts**', async (route) => {
    const method = route.request().method();
    if (method === 'POST') ids.push(route.request().postDataJSON().id);
    const response = await route.fetch();
    if ((method === 'POST' && loseCreate) || (method === 'PATCH' && loseUpdate)) {
      if (method === 'POST') loseCreate = false;
      else loseUpdate = false;
      expect(response.ok()).toBe(true);
      // Commit succeeded, but the client did not receive the successful response.
      return route.fulfill({
        status: 503,
        json: { code: 'TEMPORARY_ERROR', message: 'Resposta perdida no teste.' },
      });
    }
    return route.fulfill({ response });
  });
  await page.goto('/#shortcuts');
  await page.getByRole('button', { name: 'Criar atalho' }).click();
  await page.getByLabel('Nome do atalho').fill('Resposta perdida');
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill(message);
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.getByRole('alert')).toContainText('Resposta perdida');
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.locator('.shortcut-form')).toHaveCount(0);
  expect(ids.length).toBe(2);
  expect(ids[0]).toBe(ids[1]);
  const stored = (await (await page.request.get('/api/v1/shortcuts')).json()).shortcuts;
  expect(stored.filter((item: { name: string }) => item.name === 'Resposta perdida')).toHaveLength(
    1,
  );
  await page.getByRole('button', { name: 'Editar Resposta perdida', exact: true }).click();
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Texto editado');
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.getByRole('alert')).toContainText('Resposta perdida');
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.locator('.shortcut-form')).toHaveCount(0);
  const updated = (await (await page.request.get('/api/v1/shortcuts')).json()).shortcuts.find(
    (item: { id: string }) => item.id === ids[0],
  );
  expect(updated.version).toBe(2);
  expect(updated.body).toBe('Texto editado');
});

test('atalhos: conflito entre aparelhos preserva rascunho e permite carregar versão atual', async ({
  page,
}) => {
  await login(page);
  const shortcut = await createShortcut(page, 'Edição simultânea');
  await page.goto('/#shortcuts');
  await page.getByRole('button', { name: 'Editar Edição simultânea' }).click();
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Meu rascunho');
  const update = await page.request.patch(`/api/v1/shortcuts/${shortcut.id}`, {
    headers,
    data: { name: 'Edição simultânea', body: 'Atualizado no outro aparelho', expected_version: 1 },
  });
  expect(update.ok()).toBe(true);
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.getByRole('alert')).toContainText('O atalho mudou');
  await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue(
    'Meu rascunho',
  );
  await expect(page.getByRole('button', { name: 'Salvar atalho' })).toBeDisabled();
  await page.getByRole('button', { name: 'Carregar versão atual' }).click();
  await expect(page.getByRole('textbox', { name: 'Mensagem', exact: true })).toHaveValue(
    'Atualizado no outro aparelho',
  );
  await page.getByRole('textbox', { name: 'Mensagem', exact: true }).fill('Revisado após conflito');
  await page.getByRole('button', { name: 'Salvar atalho' }).click();
  await expect(page.locator('.shortcut-form')).toHaveCount(0);
  await expect(
    page.locator('.shortcut-card').filter({ hasText: 'Edição simultânea' }),
  ).toContainText('Revisado após conflito');
});

test('atalhos no chat: resposta pendente não troca a conversa nem duplica o envio', async ({
  page,
}) => {
  await login(page);
  await createShortcut(page, 'Saudação segura');
  await chat(page);
  const requests: { url: string; text: string; key: string }[] = [];
  let completeSend!: () => void;
  const sendGate = new Promise<void>((resolve) => {
    completeSend = resolve;
  });
  await page.route('**/api/v1/conversations/*/messages', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    requests.push({
      url: route.request().url(),
      text: route.request().postDataJSON().text,
      key: route.request().headers()['idempotency-key'],
    });
    await sendGate;
    return route.fulfill({ json: { status: 'sent' } });
  });
  await page.getByLabel('Mensagem para o Instagram').fill('Rascunho da Ana');
  await page.getByRole('button', { name: 'Abrir atalhos de mensagem' }).click();
  const shortcut = page
    .getByRole('region', { name: 'Atalhos de mensagem', exact: true })
    .getByRole('button', { name: /Saudação segura/ });
  await expect(shortcut).toBeVisible();
  await shortcut.evaluate((element: HTMLButtonElement) => {
    element.click();
    element.click();
  });
  await expect.poll(() => requests.length).toBe(1);
  await page.locator('.inbox-conversations').getByRole('button', { name: /Bruna/ }).click();
  await expect(page.getByText('Histórico conversation-1', { exact: true })).toBeVisible();
  completeSend();
  await expect(page.getByLabel('Mensagem para o Instagram')).toBeEnabled();
  await expect(page.getByText('Histórico conversation-1', { exact: true })).toBeVisible();
  await expect(page.getByText('Histórico conversation-0', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Mensagem para o Instagram')).toHaveValue('');
  expect(requests).toHaveLength(1);
  expect(requests[0].url).toContain('/conversation-0/messages');
  expect(requests[0].text).toBe(message);
  await page.locator('.inbox-conversations').getByRole('button', { name: /Ana/ }).click();
  await expect(page.getByLabel('Mensagem para o Instagram')).toHaveValue('Rascunho da Ana');
});

test('atalhos no chat: lista atualizada, nova tentativa segura e encaixe no celular', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await login(page);
  const shortcut = await createShortcut(page, 'Atalho mobile');
  await chat(page);
  const picker = page.getByRole('region', { name: 'Atalhos de mensagem', exact: true });
  const open = page.getByRole('button', { name: 'Abrir atalhos de mensagem' });
  await open.click();
  await expect(picker.getByRole('button', { name: /Atalho mobile/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(open).toBeFocused();
  await page.request.patch(`/api/v1/shortcuts/${shortcut.id}`, {
    headers,
    data: { name: 'Mobile atualizado', body: 'Mensagem atualizada', expected_version: 1 },
  });
  await open.click();
  await expect(picker.getByRole('button', { name: /Mobile atualizado/ })).toBeVisible();
  await expect(picker.getByRole('button', { name: /Atalho mobile/ })).toHaveCount(0);
  const menuBounds = (await picker.boundingBox())!;
  const composerBounds = (await page.locator('.thread-composer').boundingBox())!;
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(390);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(composerBounds.y);
  const keys: string[] = [];
  await page.route('**/api/v1/conversations/*/messages', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1)
      return route.fulfill({
        status: 503,
        json: { code: 'TEMPORARY_ERROR', message: 'Resposta de envio perdida' },
      });
    return route.fulfill({ json: { status: 'delivered' } });
  });
  await picker.getByRole('button', { name: /Mobile atualizado/ }).click();
  await expect(page.getByText('Resposta de envio perdida', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Voltar para conversas' }).click();
  await page.locator('.inbox-conversations').getByRole('button', { name: /Ana/ }).click();
  await open.click();
  await picker.getByRole('button', { name: /Mobile atualizado/ }).click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toBe(keys[1]);
  await expect(open).toBeEnabled();
  // Once delivery is confirmed, a deliberate new send uses a fresh key.
  await open.click();
  await picker.getByRole('button', { name: /Mobile atualizado/ }).click();
  await expect.poll(() => keys.length).toBe(3);
  expect(keys[2]).not.toBe(keys[1]);
});
