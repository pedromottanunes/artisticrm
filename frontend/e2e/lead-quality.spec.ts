import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

test.use({ serviceWorkers: 'block' });
for (const mobile of [false, true]) {
  test(`selo persiste, arquiva e entrega reposição (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
    playwright,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1360, height: 950 });
    const manager = await playwright.request.newContext({
      baseURL: 'http://127.0.0.1:5175',
      extraHTTPHeaders: { 'X-Artisti-Client': 'web' },
    });
    try {
      expect(
        (
          await manager.post('/api/v1/auth/login', {
            data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
          })
        ).ok(),
      ).toBe(true);
      const workspace = await (await manager.get('/api/v1/workspace')).json();
      const create = async (name: string) => {
        const response = await manager.post('/api/v1/opportunities', {
          headers: { 'Idempotency-Key': randomUUID() },
          data: {
            name,
            phone: `55489${String(Date.now()).slice(-8)}`,
            unit: 'Teste',
            source: 'Cadastro manual',
          },
        });
        expect(response.status(), await response.text()).toBe(201);
        const { id } = await response.json();
        return (await manager.get(`/api/v1/opportunities/${id}`)).json();
      };
      const name = `Não comercial ${mobile ? 'mobile' : 'desktop'}`;
      const first = await create(name);
      const consultant = workspace.users.find(
        (user: { id: string }) => user.id === first.reserved_to,
      );
      expect(consultant).toBeTruthy();
      expect(
        (
          await page.request.post('/api/v1/auth/login', {
            headers: { 'X-Artisti-Client': 'web' },
            data: { login: consultant.email, password: 'Artisti.demo2026!' },
          })
        ).ok(),
      ).toBe(true);
      expect(
        (
          await page.request.post(`/api/v1/opportunities/${first.id}/claim`, {
            headers: { 'X-Artisti-Client': 'web', 'Idempotency-Key': randomUUID() },
            data: { mode: 'reservation', expected_version: first.version },
          })
        ).ok(),
      ).toBe(true);
      await page.goto('/#lists');
      await page.getByRole('button', { name: `Abrir ficha de ${name}`, exact: true }).click();
      await page.getByRole('button', { name: 'Marcar não comercial', exact: true }).click();
      const classification = page.getByRole('dialog').filter({
        has: page.getByRole('heading', { name: 'Classificação do contato', exact: true }),
      });
      await expect(
        classification.getByText('Uma reposição será registrada', { exact: false }),
      ).toBeVisible();
      await classification.getByLabel('Motivo da classificação').selectOption('JOB_SEEKER');
      await classification.getByRole('button', { name: 'Aplicar selo', exact: true }).click();
      await expect(
        page.getByText('Classificado e silenciado. Reposição registrada.', { exact: true }).first(),
      ).toBeVisible();
      const saved = await (await manager.get(`/api/v1/opportunities/${first.id}`)).json();
      expect(saved.non_commercial_reason).toBe('JOB_SEEKER');
      expect(saved.can_edit).toBe(false);
      const replacement = await create(`Reposição ${mobile}`);
      expect(replacement.reserved_to).toBe(consultant.id);
      expect(replacement.reservation_origin).toBe('compensation');
      await page.reload();
      await expect(
        page.getByRole('button', { name: `Abrir ficha de ${name}`, exact: true }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: /Não comerciais/ }).click();
      await page.getByRole('button', { name: `Abrir ficha de ${name}`, exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Procura de emprego', exact: true }),
      ).toBeVisible();
      const detail = page.getByRole('dialog');
      const width = await detail.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
      expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
      if (mobile) {
        const menu = page.getByLabel('Mais ações do lead');
        await menu.click();
        await expect(
          page.getByRole('button', { name: 'Abrir conversa', exact: true }),
        ).toBeVisible();
        await menu.click();
      } else {
        await expect(page.getByRole('button', { name: 'WhatsApp', exact: true })).toBeVisible();
      }
      await expect(detail.getByRole('button', { name: 'Assumir lead', exact: true })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: 'Procura de emprego', exact: true }).click();
      await expect(
        classification.getByText('Reposição já entregue.', { exact: true }),
      ).toBeVisible();
      await expect(
        classification.getByRole('button', { name: 'Restaurar atendimento' }),
      ).toHaveCount(0);
    } finally {
      await manager.dispose();
    }
  });

  test(`chat mostra selo, mantém resposta e silencia alertas (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1360, height: 950 });
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          headers: { 'X-Artisti-Client': 'web' },
          data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
        })
      ).ok(),
    ).toBe(true);
    const { user } = await (await page.request.get('/api/v1/workspace')).json();
    const created = await page.request.post('/api/v1/opportunities', {
      headers: { 'X-Artisti-Client': 'web', 'Idempotency-Key': randomUUID() },
      data: {
        name: 'Contato do chat',
        phone: `55489${String(Date.now()).slice(-8)}`,
        source: 'Indicação',
      },
    });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const conversationId = randomUUID();
    // Only Instagram transport is simulated; classification, permissions and persistence use the real API.
    await page.route('**/api/v1/conversations?*', async (route) => {
      const lead = await (await page.request.get(`/api/v1/opportunities/${id}`)).json();
      const archived = new URL(route.request().url()).searchParams.get('view') === 'non_commercial';
      await route.fulfill({
        json: {
          configured: true,
          conversations:
            archived === Boolean(lead.non_commercial_reason)
              ? [
                  {
                    id: conversationId,
                    opportunity_id: id,
                    contact_name: 'Contato do chat',
                    instagram_username: 'contato.teste',
                    profile_picture_url: '',
                    state: 'CLAIMED',
                    owner_id: user.id,
                    reserved_to: null,
                    last_message_at: '2026-10-10T12:00:00Z',
                    unread: !archived,
                    can_send: true,
                    notifications_muted: archived,
                    non_commercial_reason: lead.non_commercial_reason,
                    messaging_mode: 'direct',
                  },
                ]
              : [],
        },
      });
    });
    await page.route(`**/api/v1/conversations/${conversationId}/messages*`, async (route) => {
      await route.fulfill({
        json: {
          conversation_id: conversationId,
          opportunity_id: id,
          can_send: true,
          messaging_mode: 'direct',
          has_more: false,
          messages: [
            {
              id: randomUUID(),
              direction: 'inbound',
              type: 'text',
              text: 'Gostaria de enviar meu currículo.',
              attachments: [],
              status: 'received',
              created_at: '2026-10-10T12:00:00Z',
            },
          ],
        },
      });
    });
    await page.route(`**/api/v1/conversations/${conversationId}/read`, (route) =>
      route.fulfill({ json: { ok: true } }),
    );
    await page.goto('/#inbox');
    if (mobile) await page.getByRole('button', { name: /^Contato do chat/ }).click();
    await page.getByRole('button', { name: 'Marcar não comercial', exact: true }).click();
    const modal = page.getByRole('dialog', { name: 'Classificação do contato' });
    await expect(
      modal.getByText('Esta classificação não gera reposição', { exact: false }),
    ).toBeVisible();
    await modal.getByLabel('Motivo da classificação').selectOption('JOB_SEEKER');
    await modal.getByRole('button', { name: 'Aplicar selo', exact: true }).click();
    await expect(
      page
        .getByText('Classificado e silenciado. Sem alteração no rodízio.', { exact: true })
        .first(),
    ).toBeVisible();
    await expect(modal).toHaveCount(0);
    await page.getByRole('button', { name: 'Não comerciais', exact: true }).click();
    if (mobile) await page.getByRole('button', { name: /^Contato do chat/ }).click();
    await expect(
      page.getByText('Gostaria de enviar meu currículo.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('Mensagem para o Instagram')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Reativar notificações deste lead' }),
    ).toHaveCount(0);
    const width = await page
      .locator('.thread-header')
      .evaluate((element) => ({ scroll: element.scrollWidth, client: element.clientWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  });
}

test('fecha ficha e link do WhatsApp quando o lead é transferido em outra aba', async ({
  page,
  playwright,
}) => {
  const manager = await playwright.request.newContext({
    baseURL: 'http://127.0.0.1:5175',
    extraHTTPHeaders: { 'X-Artisti-Client': 'web' },
  });
  try {
    expect(
      (
        await manager.post('/api/v1/auth/login', {
          data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
        })
      ).ok(),
    ).toBe(true);
    const created = await manager.post('/api/v1/opportunities', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        name: 'Transferência entre abas',
        phone: `55488${String(Date.now()).slice(-8)}`,
        unit: 'Teste',
        source: 'Cadastro manual',
      },
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = await created.json();
    const lead = await (await manager.get(`/api/v1/opportunities/${id}`)).json();
    const workspace = await (await manager.get('/api/v1/workspace')).json();
    const consultant = workspace.users.find((user: { id: string }) => user.id === lead.reserved_to);
    const replacement = workspace.users.find(
      (user: { id: string; role: string; active: boolean }) =>
        user.role === 'attendant' && user.active && user.id !== consultant.id,
    );
    expect(consultant).toBeTruthy();
    expect(replacement).toBeTruthy();
    expect(
      (
        await page.request.post('/api/v1/auth/login', {
          headers: { 'X-Artisti-Client': 'web' },
          data: { login: consultant.email, password: 'Artisti.demo2026!' },
        })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.post(`/api/v1/opportunities/${id}/claim`, {
          headers: { 'X-Artisti-Client': 'web', 'Idempotency-Key': randomUUID() },
          data: { mode: 'reservation', expected_version: lead.version },
        })
      ).ok(),
    ).toBe(true);
    await page.goto('/#lists');
    await page
      .getByRole('button', { name: 'Abrir ficha de Transferência entre abas', exact: true })
      .click();
    await page.getByRole('button', { name: 'WhatsApp', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Lead assumido', exact: true })).toBeVisible();
    const current = await (await manager.get(`/api/v1/opportunities/${id}`)).json();
    const transferred = await manager.post(`/api/v1/opportunities/${id}/transfer`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: {
        expected_version: current.version,
        target_id: replacement.id,
        reason: 'Teste de sincronização entre abas',
      },
    });
    expect(transferred.status(), await transferred.text()).toBe(200);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('heading', { name: 'Lead assumido', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await manager.dispose();
  }
});
