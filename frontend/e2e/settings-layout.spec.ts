import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const width of [320, 390, 768, 1440]) {
  test(`configurações da gestão: seções acessíveis e formulários encaixados (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'cadu@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBe(true);
    await page.route('**/api/v1/conversation-portfolio-shares', (route) =>
      route.fulfill({
        json: {
          shares: [
            {
              id: 'layout-share',
              source_user_id: 'source',
              reviewer_user_id: 'reviewer',
              source_name: 'Kalleo Andrade',
              reviewer_name: 'Consultor com sobrenome muito longo para revisão',
              conversation_count: 74,
              version: 1,
            },
          ],
        },
      }),
    );
    await page.route(/\/api\/v1\/(instagram|messenger|whatsapp)\/status$/, (route) =>
      route.fulfill({
        json: {
          configured: true,
          pending: 0,
          retrying: 0,
          last_received_at: '2026-10-15T17:29:02Z',
          last_processed_at: '2026-10-15T17:29:03Z',
        },
      }),
    );
    await page.goto('/#settings');
    const toggles = page.locator('.settings-section-toggle');
    await expect(toggles).toHaveCount(6);
    await expect(page.locator('.settings-section-body:visible')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Recolher tudo' })).toBeDisabled();
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: `test-results/settings-${width}-collapsed.png`,
        fullPage: true,
      });

    // Collapsing must preserve form data and support the keyboard without submitting.
    const passwordToggle = page.getByRole('button', { name: 'Alterar minha senha', exact: true });
    await passwordToggle.focus();
    await page.keyboard.press('Enter');
    await expect(passwordToggle).toHaveAttribute('aria-expanded', 'true');
    await page.getByLabel('Senha atual ou temporária').fill('rascunho-local');
    await passwordToggle.focus();
    await page.keyboard.press('Space');
    await expect(page.getByLabel('Senha atual ou temporária')).toBeHidden();
    await passwordToggle.click();
    await expect(page.getByLabel('Senha atual ou temporária')).toHaveValue('rascunho-local');

    for (const toggle of await toggles.all()) {
      if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    }
    await expect(page.locator('.settings-section-body:visible')).toHaveCount(6);
    await expect(page.getByText('74 conversas para revisão')).toBeVisible();
    // Check actual content bounds, because the application's overflow:hidden can mask clipping.
    const overflow = await page.locator('.manager-settings').evaluate((root) =>
      [
        ...root.querySelectorAll<HTMLElement>(
          '.settings-section, .team-list article, .portfolio-share-list article, input, select, button',
        ),
      ]
        .filter(
          (element) => element.getClientRects().length && !element.closest('dialog:not([open])'),
        )
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return (
            box.left < -1 ||
            box.right > innerWidth + 1 ||
            element.scrollWidth > element.clientWidth + 1
          );
        })
        .map((element) => ({ tag: element.tagName, text: element.textContent?.slice(0, 70) })),
    );
    expect(overflow).toEqual([]);
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: `test-results/settings-${width}-expanded.png`,
        fullPage: true,
      });

    await page.getByRole('button', { name: 'Recolher tudo' }).click();
    await expect(page.locator('.settings-section-body:visible')).toHaveCount(0);
    await passwordToggle.click();
    await expect(page.getByLabel('Senha atual ou temporária')).toHaveValue('rascunho-local');

    // Account-management dialogs still fit with the mobile keyboard taking up space.
    await page.getByRole('button', { name: 'Equipe e acessos', exact: true }).click();
    await page.getByRole('button', { name: 'Nova atendente', exact: true }).click();
    if (width < 760) await page.setViewportSize({ width, height: 450 });
    const dialog = page.getByRole('dialog', { name: 'Nova atendente', exact: true });
    await expect(dialog.getByLabel('Nome da atendente')).toBeVisible();
    await dialog.getByLabel('Nome da atendente').fill('Rascunho de cadastro');
    await dialog.getByRole('button', { name: 'Confirmar alteração' }).scrollIntoViewIfNeeded();
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.height).toBeLessThanOrEqual(width < 760 ? 450 : 900);
    await dialog.getByRole('button', { name: 'Fechar janela' }).click();
    await expect(dialog).toBeHidden();
  });
}
