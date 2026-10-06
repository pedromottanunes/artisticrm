import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
async function login(page: Page, profile: string) {
  const result = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(result.ok()).toBe(true);
}

for (const profile of ['vanessa', 'cadu']) {
  test(`sessão persiste após recarregar durante indisponibilidade: ${profile}`, async ({
    page,
  }) => {
    await login(page, profile);
    const before = (await page.context().cookies()).find((c) => c.name === 'artisti_session')!;
    expect(before.httpOnly).toBe(true);
    expect(before.expires - Date.now() / 1000).toBeGreaterThan(29 * 86400);
    let unavailable = true;
    await page.route('**/api/v1/workspace?*', (route) =>
      unavailable
        ? route.fulfill({ status: 503, json: { message: 'Reiniciando servidor' } })
        : route.continue(),
    );
    await page.goto('/#settings');
    await expect(page.getByText('Reconectando ao CRM', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Entrar no Artisti CRM' })).toBeHidden();
    expect((await page.context().cookies()).find((c) => c.name === 'artisti_session')?.value).toBe(
      before.value,
    );
    unavailable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.locator('.app-shell')).toBeVisible();
    expect(await page.evaluate(() => document.cookie)).not.toContain('artisti_session');
    await page.reload();
    await expect(page.locator('.app-shell')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Entrar no Artisti CRM' })).toBeHidden();
  });
}

test('falha temporária preserva a tela aberta; logout verdadeiro pede login', async ({ page }) => {
  await login(page, 'vanessa');
  await page.goto('/#mine');
  await expect(page.locator('.app-shell')).toBeVisible();
  let unavailable = true;
  await page.route('**/api/v1/workspace?*', (route) =>
    unavailable ? route.abort('connectionreset') : route.continue(),
  );
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText(/Conexão interrompida/)).toBeVisible();
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrar no Artisti CRM' })).toBeHidden();
  unavailable = false;
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByText(/Conexão interrompida/)).toBeHidden();
  const logout = await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-Artisti-Client': 'web' },
    data: {},
  });
  expect(logout.ok()).toBe(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Entrar no Artisti CRM' })).toBeVisible();
  await expect(page.getByText('Reconectando ao CRM', { exact: true })).toBeHidden();
});

test('401 durante reconexão termina a espera e permite autenticar novamente', async ({ page }) => {
  let status = 503;
  await page.route('**/api/v1/workspace?*', (route) =>
    route.fulfill({ status, json: { message: 'Indisponível' } }),
  );
  await page.goto('/');
  await expect(page.getByText('Reconectando ao CRM', { exact: true })).toBeVisible();
  status = 401;
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Entrar no Artisti CRM' })).toBeVisible();
});
