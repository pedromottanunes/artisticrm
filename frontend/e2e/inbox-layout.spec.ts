import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const profile of ['cadu', 'vanessa'] as const) {
  for (const width of [320, 390, 1440]) {
    test(`conversas compactas: espaço útil e filtros preservados para ${profile} (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const login = await page.request.post('/api/v1/auth/login', {
        headers: { 'X-Artisti-Client': 'web' },
        data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
      });
      expect(login.ok()).toBe(true);
      const { user, users } = await (await page.request.get('/api/v1/workspace')).json();
      const owner =
        profile === 'vanessa'
          ? user
          : users.find((item: { role: string }) => item.role === 'attendant');
      const names = [
        'Eduardo Almeida',
        'Mariana Costa',
        'Carlos Oliveira',
        'Ana Souza',
        'Lucas Martins',
        'Rodrigo Barbosa',
        'Juliana Ferreira',
        'Felipe Ramos',
        'Rafael Silva',
        'Paula Almeida',
        'Bruno Santos',
        'Renata Lima',
      ];
      const conversations = names.map((name, index) => ({
        id: `layout-${index}`,
        opportunity_id: `lead-${index}`,
        contact_name: name,
        channel: 'instagram',
        instagram_username: name.toLowerCase().replace(' ', '.'),
        profile_picture_url: '',
        state: 'CLAIMED',
        owner_id: owner.id,
        reserved_to: null,
        unread: index === 1,
        can_send: profile === 'vanessa',
        messaging_mode: 'direct',
        last_message_at: `2026-11-02T12:${String(59 - index).padStart(2, '0')}:00Z`,
      }));
      await page.route('**/api/v1/conversations?*', (route) => {
        const view = new URL(route.request().url()).searchParams.get('view');
        const archived = view === 'non_commercial';
        return route.fulfill({
          json: {
            configured: true,
            conversations: archived ? [conversations[0]] : conversations,
            has_more: !archived && profile === 'cadu',
            next_before_at: conversations.at(-1)!.last_message_at,
            next_before_id: conversations.at(-1)!.id,
          },
        });
      });
      await page.route('**/api/v1/conversations/*/read', (route) => route.fulfill({ json: {} }));
      await page.route('**/api/v1/conversations/*/messages*', (route) => {
        const id = new URL(route.request().url()).pathname.split('/')[4];
        const conversation = conversations.find((item) => item.id === id)!;
        return route.fulfill({
          json: {
            conversation_id: id,
            opportunity_id: conversation.opportunity_id,
            can_send: conversation.can_send,
            messaging_mode: 'direct',
            has_more: false,
            last_message_at: conversation.last_message_at,
            messages: [],
          },
        });
      });
      await page.goto('/#inbox');
      const rows = page.locator('.inbox-conversations > button');
      await expect(rows).toHaveCount(12);
      const tabs = page.getByRole('group', { name: 'Tipo de atendimento' });
      await expect(tabs).toBeVisible();
      if (width <= 1024) {
        expect(await tabs.evaluate((element) => !!element.closest('.topbar'))).toBe(true);
        await expect(page.getByText('CAIXA MULTICANAL', { exact: true })).toBeHidden();
        await expect(page.locator('.inbox-list h2')).toBeHidden();
        await expect
          .poll(() =>
            page.evaluate(() => {
              const header = document.querySelector('.topbar')!.getBoundingClientRect();
              const toolbar = document
                .querySelector('.inbox-list-toolbar')!
                .getBoundingClientRect();
              return header.top >= 0 && toolbar.top >= header.bottom - 1;
            }),
          )
          .toBe(true);
        const visible = await rows.evaluateAll((elements) => {
          const list = document.querySelector('.inbox-conversations')!.getBoundingClientRect();
          const nav = document.querySelector('.mobile-bottom-nav')!.getBoundingClientRect();
          return elements.filter((element) => {
            const box = element.getBoundingClientRect();
            return box.top >= list.top - 1 && box.bottom <= Math.min(list.bottom, nav.top) + 1;
          }).length;
        });
        expect(visible).toBeGreaterThanOrEqual(profile === 'cadu' ? 5 : 7);
        await test
          .info()
          .attach('visible-leads', {
            body: JSON.stringify({ profile, width, visible }),
            contentType: 'application/json',
          });
        if (profile === 'cadu') {
          expect(
            (await page.getByRole('navigation', { name: 'Páginas de conversas' }).boundingBox())!
              .height,
          ).toBeLessThanOrEqual(54);
        } else {
          await expect(
            tabs.getByRole('button', { name: 'Para revisar', exact: true }),
          ).toBeVisible();
        }
      } else {
        expect(await tabs.evaluate((element) => !!element.closest('.inbox-list'))).toBe(true);
        await expect(page.getByText('CAIXA MULTICANAL', { exact: true })).toBeVisible();
      }
      await expect(page.getByRole('button', { name: 'Atualizar conversas' })).toBeVisible();
      await expect(page.getByRole('searchbox', { name: 'Buscar lead por nome' })).toBeVisible();
      await page.screenshot({ path: test.info().outputPath('conversas.png'), fullPage: false });
      await tabs.getByRole('button', { name: 'Não comerciais', exact: true }).click();
      await expect(rows).toHaveCount(1);
      await page.setViewportSize({ width: width <= 1024 ? 1440 : 390, height: 844 });
      await expect(
        tabs.getByRole('button', { name: 'Não comerciais', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(rows).toHaveCount(1);
      await page.setViewportSize({ width, height: 844 });
      await tabs.getByRole('button', { name: 'Ativos', exact: true }).click();
      await expect(rows).toHaveCount(12);
      if (width <= 760) {
        await rows.first().click();
        await expect(page.getByRole('button', { name: 'Voltar para conversas' })).toBeVisible();
        await expect(tabs).toBeHidden();
        await page.getByRole('button', { name: 'Voltar para conversas' }).click();
        await expect(tabs).toBeVisible();
      }
      await page.goto('/#lists');
      await expect(page.locator('.topbar .quality-tabs')).toHaveCount(0);
    });
  }
}
