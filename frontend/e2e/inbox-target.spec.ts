import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [390, 1440]) {
  test(`gestor abre conversa fora da primeira página sem prender a paginação (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBe(true);
    const workspace = await (await page.request.get('/api/v1/workspace')).json();
    const owner = workspace.users.find((user: { role: string }) => user.role === 'attendant');
    const row = (index: number, name: string) => ({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      opportunity_id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      contact_name: name,
      owner_id: owner.id,
      channel: 'messenger',
      state: 'CLAIMED',
      version: 1,
      can_send: false,
      last_message_at: `2026-10-15T${index === 1 ? '15' : '14'}:00:00Z`,
      unread: false,
      notifications_muted: false,
    });
    const first = row(1, 'Conversa recente');
    const second = row(2, 'Conversa da segunda página');
    const target = row(99, 'Conversa antiga solicitada');
    const queries: URLSearchParams[] = [];
    let targetAvailable = true;
    let delayed = false;
    let release: (() => void) | undefined;
    let delayCompleted: Promise<void> | undefined;
    await page.route(/\/api\/v1\/conversations\?/, async (route) => {
      const params = new URL(route.request().url()).searchParams;
      queries.push(params);
      let done: (() => void) | undefined;
      if (delayed && params.has('target_opportunity_id')) {
        delayed = false;
        delayCompleted = new Promise<void>((resolve) => {
          done = resolve;
        });
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      const next = params.has('before_id');
      const response = {
        configured: true,
        conversations: [next ? second : first],
        has_more: !next,
        next_before_at: next ? null : first.last_message_at,
        next_before_id: next ? null : first.id,
        ...(params.has('target_opportunity_id')
          ? { target_conversation: targetAvailable ? target : null }
          : {}),
      };
      try {
        await route.fulfill({ json: response });
      } catch {
        /* A changed filter cancels the request. */
      } finally {
        done?.();
      }
    });
    const histories: string[] = [];
    await page.route(/\/api\/v1\/conversations\/[^/]+\/messages(?:\?.*)?$/, (route) => {
      const id = new URL(route.request().url()).pathname.split('/')[4];
      const item = [first, second, target].find((entry) => entry.id === id)!;
      histories.push(id);
      return route.fulfill({
        json: {
          conversation_id: id,
          opportunity_id: item.opportunity_id,
          last_message_at: item.last_message_at,
          can_send: false,
          has_more: false,
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
    await page.route(/\/api\/v1\/conversations\/[^/]+\/read$/, (route) =>
      route.fulfill({ json: {} }),
    );
    await page.goto(`/#inbox?lead=${target.opportunity_id}`);
    await expect(page.getByText('Histórico: Conversa antiga solicitada')).toBeVisible();
    expect(histories.every((id) => id === target.id)).toBe(true);
    await expect(page.getByRole('textbox', { name: /Mensagem para/ })).toHaveCount(0);
    // A background refresh must retain the explicitly opened old conversation.
    const count = queries.length;
    await expect.poll(() => queries.length, { timeout: 8000 }).toBeGreaterThan(count);
    await expect(page.getByText('Histórico: Conversa antiga solicitada')).toBeVisible();
    if (width < 760) await page.getByRole('button', { name: 'Voltar para conversas' }).click();
    await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
    await expect(page.getByText('Página 2')).toBeVisible();
    await expect(
      page.getByRole('button', { name: second.contact_name, exact: true }),
    ).toBeVisible();
    expect(queries.at(-1)?.get('before_id')).toBe(first.id);
    expect(queries.at(-1)?.has('target_opportunity_id')).toBe(false);
    await expect(page.getByRole('button', { name: target.contact_name, exact: true })).toHaveCount(
      0,
    );
    await page.getByRole('button', { name: 'Mais recentes', exact: true }).click();
    await expect(page.getByRole('button', { name: first.contact_name, exact: true })).toBeVisible();

    // Missing targets warn instead of automatically loading an unrelated lead.
    targetAvailable = false;
    histories.length = 0;
    await page.goto(`/#inbox?lead=${target.opportunity_id}`);
    await page.reload();
    await expect(
      page.getByText(
        'A conversa solicitada não está disponível nesta categoria. Selecione outra conversa.',
      ),
    ).toBeVisible();
    await expect(page.locator('.thread-messages')).toHaveCount(0);
    expect(histories).toEqual([]);
    await page.getByRole('button', { name: 'Mais antigas', exact: true }).click();
    await expect(
      page.getByRole('button', { name: second.contact_name, exact: true }),
    ).toBeVisible();
    expect(queries.at(-1)?.get('before_id')).toBe(first.id);

    // Changing the consultant while a direct-target request is pending wins.
    targetAvailable = true;
    await page.goto('/#inbox');
    await page.reload();
    await expect(page.getByLabel('Consultor responsável', { exact: true })).toBeVisible();
    delayed = true;
    await page.evaluate((id) => {
      window.location.hash = `inbox?lead=${id}`;
    }, target.opportunity_id);
    await expect.poll(() => Boolean(release)).toBe(true);
    await page.getByLabel('Consultor responsável', { exact: true }).selectOption(owner.id);
    await expect.poll(() => queries.at(-1)?.get('owner_id')).toBe(owner.id);
    release!();
    await delayCompleted;
    await expect(page.getByRole('button', { name: first.contact_name, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: target.contact_name, exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByLabel('Consultor responsável', { exact: true })).toHaveValue(owner.id);
  });
}
