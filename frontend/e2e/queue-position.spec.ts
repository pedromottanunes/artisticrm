import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function login(page: Page, profile: string) {
  const result = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(result.ok()).toBe(true);
}

test('consultor vê somente sua posição atual da fila no celular', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'vanessa');
  let status: { participating: boolean; rank: number | null } = {
    participating: true,
    rank: 4,
  };
  const payloads: Record<string, unknown>[] = [];
  await page.route('**/api/v1/queue/me', async (route) => {
    payloads.push({ ...status });
    await route.fulfill({ json: status });
  });

  await page.goto('/#mine');
  const indicator = page.locator('.consultant-queue-position');
  await expect(indicator).toHaveText('Você é a 4ª da fila');
  const box = await indicator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(Object.keys(payloads[0]).sort()).toEqual(['participating', 'rank']);

  status = { participating: true, rank: 1 };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(indicator).toHaveText('Você é a próxima da fila');

  status = { participating: false, rank: null };
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(indicator).toHaveText('Você está fora da fila');
});

test('gestão não recebe o indicador pessoal de consultor', async ({ page }) => {
  await login(page, 'cadu');
  let queueRequests = 0;
  await page.route('**/api/v1/queue/me', async (route) => {
    queueRequests += 1;
    await route.fulfill({ status: 403, json: { message: 'Acesso negado' } });
  });
  await page.goto('/');
  await expect(page.locator('.app-shell')).toBeVisible();
  await expect(page.locator('.consultant-queue-position')).toHaveCount(0);
  expect(queueRequests).toBe(0);
});
