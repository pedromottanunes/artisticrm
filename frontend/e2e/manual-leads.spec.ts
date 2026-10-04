import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
for (const mobile of [false, true]) {
  test(`consultor cadastra indicação sem rodízio (${mobile ? 'mobile' : 'desktop'})`, async ({
    page,
  }) => {
    await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 });
    const login = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(login.ok()).toBeTruthy();
    const { user } = await (await page.request.get('/api/v1/workspace')).json();
    const name = `Indicação ${mobile ? 'mobile' : 'desktop'}`;
    const phone = `55489${Date.now().toString().slice(-8)}`;
    await page.goto('/');
    await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Cadastro manual', exact: true }).click();
    await expect(dialog.getByLabel('Origem informada')).toHaveValue('Indicação');
    await dialog.getByLabel('Nome do contato').fill(name);
    await dialog.getByLabel('WhatsApp com país e DDD').fill(phone);
    await dialog.getByLabel('Unidade', { exact: true }).fill('Florianópolis');
    await expect(dialog.getByRole('button', { name: 'Cadastrar e distribuir' })).toHaveCount(0);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' && response.url().endsWith('/api/v1/opportunities'),
    );
    await dialog.getByRole('button', { name: 'Cadastrar lead', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    const detail = await (await page.request.get(`/api/v1/opportunities/${id}`)).json();
    expect(detail.owner_id).toBe(user.id);
    expect(detail.state).toBe('CLAIMED');
    expect(detail.source).toBe('Indicação');
    expect(detail.phone).toBe(phone);
    expect(detail.unit).toBe('Florianópolis');
    dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name, exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Salvar cadastro', exact: true }),
    ).toBeVisible();
    const width = await dialog.evaluate((element) => ({
      scroll: element.scrollWidth,
      client: element.clientWidth,
    }));
    expect(width.scroll).toBeLessThanOrEqual(width.client + 1);
  });
}
