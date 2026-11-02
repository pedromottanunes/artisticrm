import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1440]) {
  test(`consultora busca conversa antiga sem abrir ou ler automaticamente e preserva rascunhos (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBe(true);
    const { user } = await (await page.request.get('/api/v1/workspace')).json();
    const row = (id: string, name: string, channel = 'instagram') => ({
      id,
      opportunity_id: `lead-${id}`,
      contact_name: name,
      channel,
      instagram_username: '',
      profile_picture_url: '',
      state: 'CLAIMED',
      owner_id: user.id,
      version: 1,
      can_send: true,
      messaging_mode: 'direct',
      last_message_at: id === 'recent' ? '2026-10-25T12:00:00Z' : '2026-10-01T12:00:00Z',
      unread: true,
    });
    const recent = row('recent', 'Mariana recente');
    const older = row('older', 'Mariana antiga', 'messenger');
    const carlos = row('carlos', 'Carlos Silva');
    const queries: URLSearchParams[] = [];
    let release: (() => void) | undefined;
    let completed: Promise<void> | undefined;
    await page.route('**/api/v1/conversations?*', async (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      const search = params.get('search')?.toLowerCase() ?? '';
      let done: (() => void) | undefined;
      if (search === 'car') {
        completed = new Promise<void>((resolve) => {
          done = resolve;
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const more = search === 'mariana' && !params.has('before_id');
      const rows =
        search === 'antiga'
          ? [older]
          : search === 'mariana'
            ? [params.has('before_id') ? older : recent]
            : search === 'car'
              ? [carlos]
              : search
                ? []
                : [recent];
      try {
        await route.fulfill({
          json: {
            configured: true,
            conversations: rows,
            has_more: more,
            next_before_at: more ? recent.last_message_at : null,
            next_before_id: more ? recent.id : null,
          },
        });
      } catch {
        /* A changed search cancels the request. */
      } finally {
        done?.();
      }
    });
    const histories: string[] = [];
    const reads: string[] = [];
    await page.route('**/api/v1/conversations/*/messages*', (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      histories.push(id);
      const item = [recent, older, carlos].find((entry) => entry.id === id)!;
      return route.fulfill({
        json: {
          conversation_id: id,
          opportunity_id: item.opportunity_id,
          can_send: true,
          messaging_mode: 'direct',
          has_more: false,
          last_message_at: item.last_message_at,
          messages: [
            {
              id: `message-${id}`,
              text: `Histórico: ${item.contact_name}`,
              direction: 'inbound',
              attachments: [],
              created_at: item.last_message_at,
            },
          ],
        },
      });
    });
    await page.route('**/api/v1/conversations/*/read', (route) => {
      reads.push(route.request().url());
      return route.fulfill({ json: {} });
    });
    const back = async () => {
      if (width < 760) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    };
    await page.goto('/#inbox');
    const search = page.getByRole('searchbox', { name: 'Buscar lead por nome' });
    await expect(search).toBeVisible();
    const box = (await search.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await page.getByRole('button', { name: /^Mariana recente/ }).click();
    const composer = page.getByRole('textbox', { name: /Mensagem para/ });
    await composer.fill('Retornar sobre a consulta de Mariana');
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    await back();
    const historyCount = histories.length;
    const readCount = reads.length;
    await search.fill('antiga');
    await expect(page.getByRole('button', { name: /^Mariana antiga/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Mariana recente/ })).toHaveCount(0);
    expect(histories.length).toBe(historyCount);
    expect(reads.length).toBe(readCount);
    await page.screenshot({ path: `test-results/inbox-search-${width}.png`, fullPage: true });
    await page.getByRole('button', { name: /^Mariana antiga/ }).click();
    await expect(page.getByText('Histórico: Mariana antiga')).toBeVisible();
    await back();
    await search.fill('Mariana');
    await expect(page.getByRole('button', { name: /^Mariana recente/ })).toBeVisible();
    await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Mariana antiga/ })).toBeVisible();
    expect(queries.at(-1)?.get('search')).toBe('Mariana');
    expect(queries.at(-1)?.get('before_id')).toBe(recent.id);
    await page.getByRole('button', { name: 'Atualizar conversas' }).click();
    await expect(page.getByRole('button', { name: /^Mariana antiga/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Mariana recente/ })).toHaveCount(0);
    await expect(page.getByText('Página 2')).toBeVisible();
    const queryCount = queries.length;
    await expect.poll(() => queries.length, { timeout: 8000 }).toBeGreaterThan(queryCount);
    expect(queries.at(-1)?.get('search')).toBe('Mariana');
    expect(queries.at(-1)?.get('before_id')).toBe(recent.id);
    await page.getByRole('button', { name: 'Mais recentes', exact: true }).click();
    await page.getByRole('button', { name: /^Mariana recente/ }).click();
    await expect(composer).toHaveValue('Retornar sobre a consulta de Mariana');
    await back();
    await page.getByRole('button', { name: 'Para revisar', exact: true }).click();
    await expect.poll(() => queries.at(-1)?.get('view')).toBe('review');
    expect(queries.at(-1)?.get('search')).toBe('Mariana');
    expect(queries.at(-1)?.has('before_id')).toBe(false);
    await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
    await expect(page.getByText('Página 2')).toBeVisible();
    expect(queries.at(-1)?.get('view')).toBe('review');
    expect(queries.at(-1)?.get('search')).toBe('Mariana');
    await page.getByRole('button', { name: 'Ativos', exact: true }).click();
    await expect.poll(() => queries.at(-1)?.get('view')).toBe('mine');
    await search.fill('inexistente');
    await expect(
      page.getByText('Nenhuma conversa encontrada com esse nome nesta categoria.'),
    ).toBeVisible();
    await search.fill('');
    await expect(page.getByRole('button', { name: /^Mariana recente/ })).toBeVisible();
    expect(queries.at(-1)?.has('search')).toBe(false);
    expect(queries.at(-1)?.has('before_id')).toBe(false);
    await search.fill('car');
    await expect.poll(() => Boolean(release)).toBe(true);
    await search.fill('antiga');
    await expect(page.getByRole('button', { name: /^Mariana antiga/ })).toBeVisible();
    release!();
    await completed;
    await expect(page.getByRole('button', { name: /^Carlos Silva/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Mariana antiga/ })).toBeVisible();
  });
}

test('busca mantém categoria e responsável na gestão e reinicia a paginação', async ({ page }) => {
  await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  const workspace = await (await page.request.get('/api/v1/workspace')).json();
  const owner = workspace.users.find((user: { role: string }) => user.role === 'attendant');
  const queries: URLSearchParams[] = [];
  await page.route('**/api/v1/conversations?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const name = params.get('search') || 'Contato inicial';
    return route.fulfill({
      json: {
        configured: true,
        conversations: [
          {
            id: 'conversation',
            opportunity_id: 'lead',
            contact_name: name,
            owner_id: owner.id,
            channel: 'instagram',
            can_send: false,
            last_message_at: '2026-10-25T12:00:00Z',
          },
        ],
        has_more: !params.has('before_id'),
        next_before_at: '2026-10-25T12:00:00Z',
        next_before_id: 'conversation',
      },
    });
  });
  await page.route('**/api/v1/conversations/*/messages*', (route) =>
    route.fulfill({
      json: {
        conversation_id: 'conversation',
        opportunity_id: 'lead',
        can_send: false,
        has_more: false,
        last_message_at: '2026-10-25T12:00:00Z',
        messages: [],
      },
    }),
  );
  await page.goto('/#inbox');
  await page.getByLabel('Consultor responsável', { exact: true }).selectOption(owner.id);
  await page.getByRole('button', { name: 'Não comerciais', exact: true }).click();
  await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
  await expect(page.getByText('Página 2')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Buscar lead por nome' }).fill('Carlos');
  await expect(page.getByRole('button', { name: 'Carlos', exact: true })).toBeVisible();
  expect(queries.at(-1)?.get('owner_id')).toBe(owner.id);
  expect(queries.at(-1)?.get('view')).toBe('non_commercial');
  expect(queries.at(-1)?.has('before_id')).toBe(false);
  await expect(page.getByText('Página 1')).toBeVisible();
  await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
  await expect(page.getByText('Página 2')).toBeVisible();
  expect(queries.at(-1)?.get('search')).toBe('Carlos');
  await page.getByRole('button', { name: 'Ativos', exact: true }).click();
  await expect(page.getByText('Página 1')).toBeVisible();
  expect(queries.at(-1)?.get('search')).toBe('Carlos');
  expect(queries.at(-1)?.get('view')).toBe('all');
});

for (const action of ['enviar mensagem', 'silenciar notificações']) {
  test(`busca atual permanece após ${action} com resposta demorada`, async ({ page }) => {
    await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    const { user } = await (await page.request.get('/api/v1/workspace')).json();
    const rows = ['Ana', 'Bruno'].map((name) => ({
      id: name,
      opportunity_id: `lead-${name}`,
      contact_name: name,
      owner_id: user.id,
      channel: 'messenger',
      can_send: true,
      messaging_mode: 'direct',
      state: 'CLAIMED',
      last_message_at: '2026-10-25T12:00:00Z',
    }));
    const queries: string[] = [];
    await page.route('**/api/v1/conversations?*', (route) => {
      const search = new URL(route.request().url()).searchParams.get('search') ?? '';
      queries.push(search);
      return route.fulfill({
        json: {
          configured: true,
          conversations: rows.filter((row) => row.contact_name.includes(search)),
        },
      });
    });
    let release: (() => void) | undefined;
    const delayed = async () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    await page.route('**/api/v1/conversations/*/messages*', async (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      if (route.request().method() === 'POST') {
        expect(id).toBe('Ana');
        expect(route.request().postDataJSON()).toEqual({ text: 'Mensagem para Ana' });
        await delayed();
        return route.fulfill({ json: { status: 'sent' } });
      }
      return route.fulfill({
        json: {
          conversation_id: id,
          opportunity_id: `lead-${id}`,
          can_send: true,
          messaging_mode: 'direct',
          last_message_at: rows[0].last_message_at,
          has_more: false,
          messages: [],
        },
      });
    });
    await page.route('**/api/v1/conversations/*/notifications', async (route) => {
      await delayed();
      return route.fulfill({ json: { notifications_muted: true } });
    });
    await page.goto('/#inbox');
    const search = page.getByRole('searchbox', { name: 'Buscar lead por nome' });
    await search.fill('Ana');
    await expect.poll(() => queries.at(-1)).toBe('Ana');
    await page.getByRole('button', { name: 'Ana', exact: true }).click();
    if (action === 'enviar mensagem') {
      await page.getByRole('textbox', { name: /Mensagem para/ }).fill('Mensagem para Ana');
      await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Silenciar notificações deste lead' }).click();
    }
    await expect.poll(() => Boolean(release)).toBe(true);
    await search.fill('Bruno');
    if (action === 'enviar mensagem') {
      await expect(page.getByRole('button', { name: 'Bruno', exact: true })).toBeVisible();
    } else {
      await expect(page.getByText('Carregando conversas…', { exact: true })).toBeVisible();
    }
    const count = queries.length;
    release!();
    await expect.poll(() => queries.length).toBeGreaterThan(count);
    expect(queries.at(-1)).toBe('Bruno');
    await expect(page.getByRole('button', { name: 'Bruno', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Ana', exact: true })).toHaveCount(0);
  });
}

test('assumir uma conversa pesquisada na segunda página reinicia a página dos próprios atendimentos', async ({
  page,
}) => {
  await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  const { user } = await (await page.request.get('/api/v1/workspace')).json();
  const otherOwner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  let assumed = false;
  const queries: URLSearchParams[] = [];
  const item = (id: string) => ({
    id,
    opportunity_id: `lead-${id}`,
    contact_name: `Mariana ${id}`,
    channel: 'messenger',
    owner_id: assumed ? user.id : otherOwner,
    version: 2,
    state: 'CLAIMED',
    review_shared: !assumed,
    can_send: assumed,
    messaging_mode: 'direct',
    last_message_at: '2026-10-25T12:00:00Z',
  });
  await page.route('**/api/v1/conversations?*', (route) => {
    const params = new URL(route.request().url()).searchParams;
    queries.push(params);
    const reviewing = params.get('view') === 'review';
    const next = params.has('before_id');
    const more = reviewing && !next && !assumed;
    return route.fulfill({
      json: {
        configured: true,
        conversations: reviewing
          ? assumed
            ? []
            : [item(next ? 'antiga' : 'recente')]
          : assumed && !next
            ? [item('antiga')]
            : [],
        has_more: more,
        next_before_at: more ? item('recente').last_message_at : null,
        next_before_id: more ? 'recente' : null,
        review_source_ids: [otherOwner],
      },
    });
  });
  await page.route('**/api/v1/conversations/*/messages*', (route) =>
    route.fulfill({
      json: {
        conversation_id: 'antiga',
        opportunity_id: 'lead-antiga',
        can_send: assumed,
        messaging_mode: 'direct',
        last_message_at: item('antiga').last_message_at,
        has_more: false,
        messages: [],
      },
    }),
  );
  await page.route('**/api/v1/opportunities/*/assume-shared-conversation', (route) => {
    assumed = true;
    return route.fulfill({ json: { id: 'lead-antiga', version: 3 } });
  });
  await page.goto('/#inbox');
  await page.getByRole('button', { name: 'Para revisar', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Buscar lead por nome' }).fill('Mariana');
  await expect.poll(() => queries.at(-1)?.get('search')).toBe('Mariana');
  await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
  await page.getByRole('button', { name: 'Mariana antiga', exact: true }).click();
  await page.getByRole('button', { name: 'Assumir conversa', exact: true }).click();
  await expect.poll(() => queries.at(-1)?.get('view')).toBe('mine');
  expect(queries.at(-1)?.has('before_id')).toBe(false);
  await expect(page.getByRole('button', { name: 'Mariana antiga', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Mariana antiga', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /Mensagem para/ })).toBeVisible();
});
