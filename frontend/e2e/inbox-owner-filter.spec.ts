import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [320, 390, 768, 1440]) {
  test(`gestor filtra conversas pelo responsável, preserva categoria e pagina sem misturar (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBe(true);
    const snapshot = await (await page.request.get('/api/v1/workspace')).json();
    const template = snapshot.users.find((user: { role: string }) => user.role === 'attendant');
    const alan = {
      ...template,
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Alan Consultor',
      active: true,
      queue_enabled: true,
    };
    const kalleo = {
      ...template,
      id: '10000000-0000-4000-8000-000000000002',
      name: 'Kalleo Andrade',
      active: true,
      queue_enabled: false,
    };
    const empty = {
      ...template,
      id: '10000000-0000-4000-8000-000000000003',
      name: 'Consultor sem conversas',
      active: true,
      queue_enabled: true,
    };
    await page.route(/\/api\/v1\/workspace(?:\?.*)?$/, (route) =>
      route.fulfill({ json: { ...snapshot, users: [snapshot.user, alan, kalleo, empty] } }),
    );
    const conversation = (
      id: number,
      name: string,
      owner: string | null,
      channel = 'instagram',
    ) => ({
      id: `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      opportunity_id: `30000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      contact_name: name,
      owner_id: owner,
      channel,
      instagram_username: '',
      profile_picture_url: '',
      state: 'CLAIMED',
      version: 1,
      reserved_to: null,
      can_send: false,
      unread: false,
      notifications_muted: false,
      last_message_at: '2026-10-15T15:00:00Z',
    });
    const first = conversation(1, 'Cliente de Alan', alan.id);
    const older = conversation(2, 'Cliente antigo de Alan', alan.id, 'messenger');
    const other = conversation(3, 'Cliente de Kalleo', kalleo.id, 'messenger');
    const unassigned = conversation(4, 'Cliente sem responsável', null);
    const archived = conversation(5, 'Contato não comercial de Alan', alan.id);
    const queries: URLSearchParams[] = [];
    let delayAlan = false;
    let releaseAlan: (() => void) | undefined;
    await page.route(/\/api\/v1\/conversations\?/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      const owner = params.get('owner_id');
      if (delayAlan && owner === alan.id) {
        delayAlan = false;
        await new Promise<void>((resolve) => {
          releaseAlan = resolve;
        });
      }
      const rows =
        owner === alan.id
          ? params.get('view') === 'non_commercial'
            ? [archived]
            : params.has('before_id')
              ? [older]
              : [first]
          : owner === kalleo.id
            ? [other]
            : owner === 'unassigned'
              ? [unassigned]
              : owner === empty.id
                ? []
                : [first, other, unassigned];
      const hasMore =
        owner === alan.id && !params.has('before_id') && params.get('view') !== 'non_commercial';
      await route
        .fulfill({
          json: {
            configured: true,
            conversations: rows,
            has_more: hasMore,
            next_before_at: hasMore ? first.last_message_at : null,
            next_before_id: hasMore ? first.id : null,
            revision: (owner === alan.id ? 'a' : 'b').repeat(64),
          },
        })
        .catch(() => {});
    });
    await page.route(/\/api\/v1\/conversations\/[^/]+\/messages(?:\?.*)?$/, (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      const row = [first, older, other, unassigned, archived].find((item) => item.id === id)!;
      return route.fulfill({
        json: {
          conversation_id: id,
          opportunity_id: row.opportunity_id,
          can_send: false,
          has_more: false,
          last_message_at: row.last_message_at,
          messages: [
            {
              id: `message-${id}`,
              text: `Histórico: ${row.contact_name}`,
              direction: 'inbound',
              attachments: [],
              created_at: row.last_message_at,
            },
          ],
        },
      });
    });
    await page.route(/\/api\/v1\/conversations\/[^/]+\/read$/, (route) =>
      route.fulfill({ json: {} }),
    );
    await page.goto('/#inbox');
    const filter = page.getByLabel('Consultor responsável', { exact: true });
    await expect(filter).toBeVisible();
    await expect(page.locator('.inbox-conversations > button')).toHaveCount(3);
    await expect(filter.locator('optgroup[label="Consultores desativados"] option')).toHaveText([
      'Kalleo Andrade',
    ]);
    if (width !== 320)
      await page.screenshot({ path: `test-results/conversations-${width}.png`, fullPage: true });
    const box = (await filter.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    await filter.selectOption(alan.id);
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Alan/);
    expect(queries.at(-1)?.get('owner_id')).toBe(alan.id);
    expect(queries.at(-1)?.has('revision')).toBe(false);
    await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
    await expect(page.getByText('Página 2')).toBeVisible();
    await expect(page.locator('.inbox-conversations > button')).toHaveText(
      /Cliente antigo de Alan/,
    );
    await page.getByRole('button', { name: 'Atualizar conversas' }).click();
    await expect(page.locator('.inbox-conversations > button')).toHaveText(
      /Cliente antigo de Alan/,
    );
    expect(queries.at(-1)?.get('before_id')).toBe(first.id);
    await page.getByRole('button', { name: 'Mais recentes', exact: true }).click();
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Alan/);
    await page.getByRole('button', { name: 'Não comerciais', exact: true }).click();
    await expect(page.locator('.inbox-conversations > button')).toHaveText(
      /Contato não comercial de Alan/,
    );
    await expect(filter).toHaveValue(alan.id);
    await expect(page.getByText('Página 2')).toBeHidden();
    await page.getByRole('button', { name: 'Ativos', exact: true }).click();
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Alan/);
    await filter.selectOption(kalleo.id);
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Kalleo/);
    await page.getByRole('button', { name: 'Cliente de Kalleo', exact: true }).click();
    await expect(page.getByText('Responsável: Kalleo Andrade', { exact: true })).toBeVisible();
    await expect(page.getByText('Histórico: Cliente de Kalleo')).toBeVisible();
    await expect(page.getByRole('textbox', { name: /Mensagem para/ })).toHaveCount(0);
    if (width < 760) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    await filter.selectOption('unassigned');
    await expect(page.locator('.inbox-conversations > button')).toHaveText(
      /Cliente sem responsável/,
    );
    await filter.selectOption(empty.id);
    await expect(
      page.getByText('Nenhuma conversa deste responsável nesta categoria.'),
    ).toBeVisible();
    await expect(page.getByText('Histórico: Cliente de Kalleo')).toBeHidden();
    delayAlan = true;
    await filter.selectOption(alan.id);
    await expect.poll(() => Boolean(releaseAlan)).toBe(true);
    await filter.selectOption(kalleo.id);
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Kalleo/);
    releaseAlan!();
    await expect(filter).toHaveValue(kalleo.id);
    await expect(page.locator('.inbox-conversations > button')).toHaveText(/Cliente de Kalleo/);
    await filter.selectOption('');
    await expect(page.locator('.inbox-conversations > button')).toHaveCount(3);
  });
}
