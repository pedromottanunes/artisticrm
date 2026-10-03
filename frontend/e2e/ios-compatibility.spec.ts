import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  // Exercise the missing APIs themselves, not just an iPhone user-agent string.
  await page.addInitScript(() => {
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined });
  });
});

async function login(page: Page, profile: 'cadu' | 'vanessa') {
  const response = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBeTruthy();
}

const conversation = {
  id: 'conversation-ios',
  opportunity_id: 'lead-ios',
  contact_name: 'Conversa no iPhone',
  instagram_username: 'iphone',
  profile_picture_url: '',
  state: 'CLAIMED',
  owner_id: 'fixture',
  reserved_to: null,
  last_message_at: '2026-10-03T12:00:00Z',
  unread: false,
  can_send: false,
  messaging_mode: 'direct',
};
const list = { configured: true, revision: 'ios-16', conversations: [conversation] };
const imageUrl = 'https://lookaside.fbsbx.com/shared-image';
const thread = {
  conversation_id: conversation.id,
  opportunity_id: conversation.opportunity_id,
  can_send: false,
  last_message_at: conversation.last_message_at,
  has_more: false,
  messaging_mode: 'direct',
  messages: [
    {
      id: 'message-ios',
      direction: 'inbound',
      type: 'share',
      text: 'Mensagem aberta no iPhone',
      attachments: [{ type: 'share', url: imageUrl }],
      status: 'received',
      created_at: conversation.last_message_at,
    },
  ],
};

for (const profile of ['cadu', 'vanessa'] as const) {
  test(`iOS compatibility: ${profile === 'cadu' ? 'master' : 'atendente'} abre chat, mídia e comentários`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await login(page, profile);
    await page.route('**/api/v1/conversations?*', (route) => route.fulfill({ json: list }));
    await page.route('**/api/v1/conversations/*/messages', (route) =>
      route.fulfill({ json: thread }),
    );
    await page.route('**/api/v1/conversations/*/read', (route) =>
      route.fulfill({ json: { read: true } }),
    );
    let probes = 0;
    await page.route(imageUrl, (route) => {
      if (route.request().headers().range === 'bytes=0-0') probes++;
      return route.fulfill({
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#dcefeb"/></svg>',
      });
    });
    await page.route('**/api/v1/instagram/comments*', (route) =>
      route.fulfill({ json: { configured: true, comments: [], next_cursor: null } }),
    );

    await page.goto('/#inbox');
    await page.getByRole('button', { name: 'Conversa no iPhone' }).click();
    await expect(page.getByText('Mensagem aberta no iPhone', { exact: true })).toBeVisible();
    const image = page.getByRole('img', { name: 'Imagem recebida pelo Instagram', exact: true });
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBe(160);
    await expect.poll(() => probes).toBe(1);
    await page.getByRole('button', { name: 'Abrir imagem em tamanho original' }).click();
    await expect(page.getByRole('dialog', { name: 'Imagem ampliada' })).toBeVisible();
    await page.getByRole('button', { name: 'Fechar imagem ampliada' }).click();
    await expect(page.getByText('Conexão interrompida.', { exact: false })).toHaveCount(0);
    await expect(page.getByText(/AbortSignal\.(any|timeout)/)).toHaveCount(0);

    await page.goto('/#comments');
    await expect(page.getByRole('heading', { name: 'Comentários do Instagram' })).toBeVisible();
    await expect(page.getByText('Nenhum comentário disponível')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('iOS compatibility: timeout libera a atualização para tentar novamente', async ({ page }) => {
  await login(page, 'cadu');
  await page.clock.install();
  let requests = 0;
  let holdNext = false;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/conversations?*', async (route) => {
    requests++;
    if (holdNext) {
      holdNext = false;
      await pending;
    }
    await route.fulfill({ json: list }).catch(() => {});
  });
  try {
    await page.goto('/#inbox');
    await expect(page.getByRole('button', { name: 'Conversa no iPhone' })).toBeVisible();
    const initialRequests = requests;
    holdNext = true;
    await page.getByRole('button', { name: 'Atualizar conversas' }).click();
    await expect.poll(() => requests).toBe(initialRequests + 1);
    const failed = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().includes('/api/v1/conversations?'),
    });
    await page.clock.runFor(20_100);
    await failed;
    await expect(page.getByText('Conexão interrompida.', { exact: false })).toBeVisible();
    // The timeout clears the in-flight marker, so a retry can complete immediately.
    await page.getByRole('button', { name: 'Atualizar conversas' }).click();
    await expect(page.getByRole('button', { name: 'Conversa no iPhone' })).toBeVisible();
    await expect(page.getByText('Conexão interrompida.', { exact: false })).toHaveCount(0);
    expect(requests).toBe(initialRequests + 2);
  } finally {
    release();
  }
});

test('iOS compatibility: sair do chat cancela o histórico pendente sem perder a conexão', async ({
  page,
}) => {
  await login(page, 'cadu');
  await page.route('**/api/v1/conversations?*', (route) => route.fulfill({ json: list }));
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  let histories = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/conversations/*/messages', async (route) => {
    if (++histories === 1) await pending;
    await route
      .fulfill({ json: { ...thread, messages: [{ ...thread.messages[0], attachments: [] }] } })
      .catch(() => {});
  });
  try {
    await page.goto('/#inbox');
    await page.getByRole('button', { name: 'Conversa no iPhone' }).click();
    await expect.poll(() => histories).toBe(1);
    const failed = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith('/conversation-ios/messages'),
    });
    await page.goto('/#lists');
    await failed;
    await expect(page.getByText('Conexão interrompida.', { exact: false })).toHaveCount(0);
    await page.goto('/#inbox');
    await page.getByRole('button', { name: 'Conversa no iPhone' }).click();
    await expect(page.getByText('Mensagem aberta no iPhone', { exact: true })).toBeVisible();
    expect(histories).toBe(2);
    await expect(page.getByText('Conexão interrompida.', { exact: false })).toHaveCount(0);
  } finally {
    release();
  }
});
