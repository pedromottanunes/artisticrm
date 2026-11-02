import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const profile of ['cadu', 'vanessa'] as const) {
  for (const width of [320, 390, 1440]) {
    test(`chat compacto: cabeçalho, ações e área útil para ${profile} (${width}px)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      const login = await page.request.post('/api/v1/auth/login', {
        headers: { 'X-Artisti-Client': 'web' },
        data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
      });
      expect(login.ok()).toBe(true);
      const workspace = await (await page.request.get('/api/v1/workspace')).json();
      const { user, users } = workspace;
      const owner =
        profile === 'vanessa'
          ? user
          : users.find((item: { role: string }) => item.role === 'attendant');
      await page.route('**/api/v1/workspace?*', (route) =>
        route.fulfill({
          json: {
            ...workspace,
            users: users.map((item: { id: string; name: string }) =>
              item.id === owner.id ? { ...item, name: 'Vanessa Olkosli' } : item,
            ),
          },
        }),
      );
      let name = 'Eduardo Almeida';
      const conversation = {
        id: 'compact-chat',
        opportunity_id: 'compact-lead',
        contact_name: name,
        channel: 'instagram',
        instagram_username: 'eduardo.almeida',
        state: 'CLAIMED',
        owner_id: owner.id,
        reserved_to: null,
        can_send: profile === 'vanessa',
        messaging_mode: 'direct',
        last_message_at: '2026-11-02T12:00:00Z',
        unread: false,
      };
      await page.route('**/api/v1/conversations?*', (route) =>
        route.fulfill({
          json: {
            configured: true,
            conversations: [{ ...conversation, contact_name: name }],
          },
        }),
      );
      await page.route('**/api/v1/conversations/*/read', (route) => route.fulfill({ json: {} }));
      await page.route('**/api/v1/conversations/*/messages*', (route) =>
        route.fulfill({
          json: {
            conversation_id: conversation.id,
            opportunity_id: conversation.opportunity_id,
            can_send: conversation.can_send,
            messaging_mode: 'direct',
            has_more: false,
            last_message_at: conversation.last_message_at,
            messages: [
              {
                id: 'hello',
                direction: 'inbound',
                type: 'text',
                text: 'Olá! Quero saber mais sobre a avaliação.',
                attachments: [],
                status: 'received',
                created_at: conversation.last_message_at,
              },
              {
                id: 'reply',
                direction: 'outbound',
                type: 'text',
                text: 'Olá, Eduardo! Seja bem-vindo à clínica Artisti. Sou a Vanessa e vou acompanhar seu atendimento. Qual o melhor dia para você?',
                attachments: [],
                status: 'sent',
                created_at: conversation.last_message_at,
              },
            ],
          },
        }),
      );
      const openChat = async () => {
        await page.goto('/#inbox');
        await page
          .locator('.inbox-conversations')
          .getByRole('button', { name, exact: true })
          .click();
        await expect(page.locator('.thread-header h2')).toHaveText(name);
      };
      await openChat();
      await expect(page.getByText('ATENDIMENTO PELO CRM', { exact: true })).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: 'Marcar não comercial', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Abrir ficha do lead' })).toBeVisible();
      if (profile === 'cadu') {
        await expect(page.locator('.thread-owner')).toContainText('Responsável: Vanessa Olkosli');
        await expect(page.locator('.thread-locked')).toContainText('somente leitura');
        await expect(page.locator('.thread-composer')).toHaveCount(0);
      } else {
        await page.getByLabel('Mensagem para o Instagram').fill('Vamos agendar sua avaliação?');
        await expect(page.getByRole('button', { name: 'Enviar', exact: true })).toBeEnabled();
        await expect(
          page.getByRole('button', { name: 'Silenciar notificações deste lead' }),
        ).toBeVisible();
        await expect(page.getByRole('button', { name: 'Abrir atalhos de mensagem' })).toBeVisible();
      }
      if (width <= 760) {
        const geometry = () =>
          page.locator('.thread-header').evaluate((header) => {
            const bounds = header.getBoundingClientRect();
            const heading = header.querySelector('.thread-heading')!.getBoundingClientRect();
            const actions = header.querySelector('.thread-actions')!.getBoundingClientRect();
            const nav = document.querySelector('.mobile-bottom-nav')!.getBoundingClientRect();
            const messages = document.querySelector('.thread-messages')!.getBoundingClientRect();
            const footer = document
              .querySelector('.thread-composer, .thread-locked')!
              .getBoundingClientRect();
            return {
              height: bounds.height,
              adjacent: actions.left >= heading.right,
              actionsFit: [...header.querySelectorAll('button')].every((button) => {
                const rect = button.getBoundingClientRect();
                return (
                  rect.width >= 44 &&
                  rect.height >= 44 &&
                  rect.left >= bounds.left &&
                  rect.right <= bounds.right &&
                  rect.bottom <= bounds.bottom
                );
              }),
              usable:
                messages.top >= bounds.bottom - 1 &&
                messages.height >= 180 &&
                messages.bottom <= footer.top + 1 &&
                footer.bottom <= nav.top + 1,
            };
          });
        await expect.poll(async () => (await geometry()).usable).toBe(true);
        expect(await geometry()).toMatchObject({ adjacent: true, actionsFit: true });
        expect((await geometry()).height).toBeLessThanOrEqual(width >= 375 ? 84 : 112);
      }
      await page.screenshot({ path: test.info().outputPath('chat.png'), fullPage: false });
      if (width <= 760) {
        // A reduced viewport exercises the space left for typing when the keyboard opens.
        await page.setViewportSize({ width, height: 500 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const footer = document
                .querySelector('.thread-composer, .thread-locked')!
                .getBoundingClientRect();
              const nav = document.querySelector('.mobile-bottom-nav')!.getBoundingClientRect();
              const messages = document.querySelector('.thread-messages')!.getBoundingClientRect();
              return footer.bottom <= nav.top + 1 && messages.height >= 80;
            }),
          )
          .toBe(true);
        if (profile === 'vanessa')
          await expect(page.getByLabel('Mensagem para o Instagram')).toHaveValue(
            'Vamos agendar sua avaliação?',
          );
        await page.setViewportSize({ width, height: 844 });
        name = 'Rafael Almeida de Oliveira e Albuquerque';
        await page.reload();
        await openChat();
        expect(
          await page
            .locator('.thread-header h2')
            .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        ).toBe(false);
        expect(
          await page
            .locator('.thread-header')
            .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        ).toBe(false);
        await page.screenshot({
          path: test.info().outputPath('chat-nome-longo.png'),
          fullPage: false,
        });
      }
    });
  }
}
