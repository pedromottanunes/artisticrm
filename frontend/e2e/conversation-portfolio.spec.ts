import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

test('gestor compartilha e revoga uma carteira em dois passos claros', async ({ page }) => {
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(login.ok()).toBe(true);
  let active = false;
  let posted: Record<string, string> | undefined;
  let deleted = false;
  await page.route(/\/api\/v1\/conversation-portfolio-shares(?:\/[0-9a-f-]+)?$/, async (route) => {
    const request = route.request();
    if (request.method() === 'POST') {
      posted = request.postDataJSON();
      active = true;
      return route.fulfill({ status: 201, json: { id: 'share-1', version: 1 } });
    }
    if (request.method() === 'DELETE') {
      deleted = true;
      active = false;
      return route.fulfill({ json: { revoked: true } });
    }
    return route.fulfill({
      json: {
        shares: active
          ? [
              {
                id: 'share-1',
                source_user_id: posted!.source_user_id,
                source_name: 'Kalleo Andrade',
                source_active: false,
                reviewer_user_id: posted!.reviewer_user_id,
                reviewer_name: 'Alan',
                granted_by: 'manager',
                granted_at: new Date().toISOString(),
                version: 1,
                conversation_count: 12,
              },
            ]
          : [],
      },
    });
  });
  await page.goto('/#settings');
  await expect(
    page.getByRole('heading', { name: 'Compartilhar carteira de conversas' }),
  ).toBeVisible();
  await page.getByLabel('1. Carteira que será revisada').selectOption({ index: 1 });
  await page.getByLabel('2. Quem poderá revisar').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Liberar acesso' }).click();
  await expect(page.getByText('Kalleo Andrade', { exact: true })).toBeVisible();
  await expect(page.getByText('Alan', { exact: true })).toBeVisible();
  await expect(page.getByText('12 conversas para revisão')).toBeVisible();
  expect(posted?.source_user_id).toBeTruthy();
  expect(posted?.reviewer_user_id).toBeTruthy();
  await page.getByRole('button', { name: 'Remover acesso' }).click();
  await expect(page.getByText('Nenhuma carteira está compartilhada no momento.')).toBeVisible();
  expect(deleted).toBe(true);
});

test('consultor revisa em modo leitura e assume a conversa sem perder o histórico', async ({
  page,
}) => {
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(login.ok()).toBe(true);
  const { user } = await (await page.request.get('/api/v1/workspace')).json();
  const now = new Date().toISOString();
  let assumed = false;
  let assumeBody: { expected_version: number } | undefined;
  const conversation = {
    id: 'conversation-review',
    opportunity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    channel: 'messenger',
    contact_name: 'Lead do Kalleo',
    instagram_username: '',
    profile_picture_url: '',
    state: 'CLAIMED',
    owner_id: assumed ? user.id : 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    reserved_to: null,
    version: assumed ? 3 : 2,
    last_message_at: now,
    unread: false,
    notifications_muted: false,
    can_send: assumed,
    messaging_mode: 'direct',
    review_shared: !assumed,
  };
  const olderConversation = {
    ...conversation,
    id: 'conversation-review-older',
    opportunity_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
    contact_name: 'Lead antigo do Kalleo',
    last_message_at: new Date(Date.now() - 60_000).toISOString(),
  };
  await page.route('**/api/v1/conversations?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    const view = params.get('view');
    const paginated = params.has('before_at');
    const conversations =
      view === 'review'
        ? assumed
          ? []
          : paginated
            ? [{ ...olderConversation }]
            : [{ ...conversation }]
        : assumed
          ? [{ ...conversation, owner_id: user.id, can_send: true, review_shared: false }]
          : [];
    return route.fulfill({
      json: {
        configured: true,
        conversations,
        has_more: view === 'review' && !assumed && !paginated,
        next_before_at:
          view === 'review' && !assumed && !paginated ? conversation.last_message_at : null,
        next_before_id: view === 'review' && !assumed && !paginated ? conversation.id : null,
        review_source_ids: ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      },
    });
  });
  await page.route('**/api/v1/conversations/*/read', (route) =>
    route.fulfill({ json: { read: true } }),
  );
  await page.route('**/api/v1/conversations/*/messages*', (route) => {
    const older = new URL(route.request().url()).searchParams.has('before');
    return route.fulfill({
      json: {
        conversation_id: conversation.id,
        opportunity_id: conversation.opportunity_id,
        can_send: assumed,
        messaging_mode: 'direct',
        last_message_at: now,
        has_more: false,
        has_older: !older,
        messages: [
          {
            id: older ? 'message-history-older' : 'message-history',
            direction: 'inbound',
            type: 'text',
            text: older ? 'Mensagem mais antiga preservada' : 'Histórico completo preservado',
            attachments: [],
            status: 'received',
            created_at: older ? new Date(Date.now() - 120_000).toISOString() : now,
          },
        ],
      },
    });
  });
  await page.route('**/api/v1/opportunities/*/assume-shared-conversation', (route) => {
    assumeBody = route.request().postDataJSON();
    assumed = true;
    return route.fulfill({ json: { id: conversation.opportunity_id, version: 3 } });
  });
  await page.goto('/#inbox');
  await page.getByRole('button', { name: 'Para revisar' }).click();
  await page.getByRole('button', { name: 'Carregar conversas anteriores' }).click();
  await expect(page.getByText('Lead antigo do Kalleo')).toBeVisible();
  await expect(page.getByText('Histórico completo preservado')).toBeVisible();
  await page.getByRole('button', { name: 'Carregar mensagens anteriores' }).click();
  await expect(page.getByText('Mensagem mais antiga preservada')).toBeVisible();
  await expect(
    page.getByText('Esta conversa está disponível somente para leitura.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Assumir conversa' }).click();
  await expect(page.getByLabel('Mensagem para o Messenger')).toBeVisible();
  expect(assumeBody).toEqual({ expected_version: 2 });
});
