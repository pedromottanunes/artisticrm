import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
for (const mobile of [false, true]) {
  test(`consultor cadastra perfil pelo + Novo lead (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const workspace = (await page.request.get('/api/v1/workspace')).json();
    const user = (await workspace).user;
    let submitted: any;
    let items: any[] = [];
    await page.route('**/api/v1/instagram/prospects', async (route) => {
      if (route.request().method() === 'POST') {
        submitted = route.request().postDataJSON();
        items = [
          {
            id: 'reservation-test',
            username: 'perfil.teste',
            owner_id: user.id,
            status: 'waiting',
            version: 1,
            expires_at: new Date(Date.now() + 86400_000).toISOString(),
          },
        ];
        return route.fulfill({ status: 201, json: items[0] });
      }
      return route.fulfill({ json: { configured: true, items, next_cursor: null } });
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(
      dialog.getByRole('textbox', { name: 'Perfil do Instagram', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByText('Cadastrar e distribuir')).toHaveCount(0);
    await dialog
      .getByRole('textbox', { name: 'Perfil do Instagram', exact: true })
      .fill('https://www.instagram.com/perfil.teste/');
    await dialog.getByLabel('Origem informada').selectOption('Curtida');
    await dialog.getByRole('button', { name: 'Reservar para mim' }).click();
    await expect(dialog.getByRole('status')).toContainText('reservado para você');
    expect(submitted).toEqual({
      profile: 'https://www.instagram.com/perfil.teste/',
      source: 'Curtida',
    });
    await expect(dialog.getByRole('link', { name: '@perfil.teste' })).toHaveAttribute(
      'href',
      'https://www.instagram.com/perfil.teste/',
    );
    await expect(dialog.getByText('Aguardando resposta', { exact: true })).toBeVisible();
    const width = await dialog.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  });
}

test('cadastro do consultor exibe conflito sem abrir conversa', async ({ page }) => {
  await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  await page.route('**/api/v1/instagram/prospects', (route) =>
    route.fulfill(
      route.request().method() === 'POST'
        ? {
            status: 409,
            json: {
              code: 'PROFILE_RESERVED',
              message: 'Este perfil já possui uma reserva ou atendimento.',
            },
          }
        : { json: { configured: true, items: [], next_cursor: null } },
    ),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog
    .getByRole('textbox', { name: 'Perfil do Instagram', exact: true })
    .fill('@reservado');
  await dialog.getByRole('button', { name: 'Reservar para mim' }).click();
  await expect(dialog.getByRole('alert')).toContainText('já possui uma reserva');
  await expect(
    dialog.getByRole('textbox', { name: 'Perfil do Instagram', exact: true }),
  ).toHaveValue('@reservado');
});
