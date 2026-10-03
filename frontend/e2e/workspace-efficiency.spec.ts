import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });
async function login(page: import('@playwright/test').Page) {
  const response = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBeTruthy();
}

test('workspace polling stays single-flight when a response takes more than five seconds', async ({
  page,
}) => {
  await login(page);
  let calls = 0;
  let holdNext = false;
  let release: (() => void) | undefined;
  await page.route('**/api/v1/workspace*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('appointments')).toBe('omit');
    calls++;
    if (holdNext) {
      holdNext = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.continue();
  });
  await page.clock.install();
  await page.goto('/#mine');
  await expect(page.locator('.app-shell')).toBeVisible();
  const initial = calls;
  holdNext = true;
  await page.clock.runFor(5100);
  await expect.poll(() => calls).toBe(initial + 1);
  await page.clock.runFor(10_000);
  expect(calls).toBe(initial + 1);
  const completed = page.waitForResponse('**/api/v1/workspace*');
  release!();
  await (await completed).finished();
  await page.clock.runFor(5000);
  await expect.poll(() => calls).toBe(initial + 2);
});

test('mobile agenda loads only the selected period and paginates without mixing months', async ({
  page,
}) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const calls: URL[] = [];
  await page.route('**/api/v1/appointments?*', async (route) => {
    const url = new URL(route.request().url());
    calls.push(url);
    const later = url.searchParams.has('cursor');
    await route.fulfill({
      json: {
        items: [
          {
            id: later ? 'second' : 'first',
            opportunity_id: 'fixture',
            name: later ? 'Segunda página' : 'Primeira página',
            starts_at: url.searchParams.get('from'),
            unit: 'Unidade teste',
            status: 'scheduled',
            version: 1,
            owner_id: 'fixture',
          },
        ],
        next_cursor: later ? null : 'fixture-cursor',
      },
    });
  });
  await page.goto('/#agenda');
  await expect(page.getByRole('heading', { name: 'Consultas', exact: true })).toBeVisible();
  await expect(page.getByText('Primeira página', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Próximas', exact: true }).click();
  await expect(page.getByText('Segunda página', { exact: true })).toBeVisible();
  await expect(page.getByText('Primeira página', { exact: true })).toHaveCount(0);
  await page.getByLabel('Mês da agenda').fill('2026-09');
  await expect(page.getByText('Primeira página', { exact: true })).toBeVisible();
  expect(calls.at(-1)!.searchParams.has('cursor')).toBe(false);
  const from = new Date(calls.at(-1)!.searchParams.get('from')!);
  expect(from.getMonth()).toBe(8);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});
