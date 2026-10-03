import { expect, test, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

const headers = { 'X-Artisti-Client': 'web' };
const counts = {
  ALL: 4,
  NOT_SCHEDULED: 1,
  SCHEDULED: 1,
  ATTENDED: 2,
  NO_SHOW: 1,
  FOLLOW_UP: 2,
  CONTRACT_PENDING: 1,
  CLOSED: 1,
  DECLINED: 1,
};

const row = {
  id: '10000000-0000-4000-8000-000000000091',
  name: 'Lead da lista',
  source: 'Meta Ads',
  stage: 'FOLLOW_UP',
  consultation_status: 'ATTENDED',
  owner_id: 'fixture-owner',
  reserved_to: null,
  state: 'CLAIMED',
  next_action: 'Enviar proposta',
};

async function login(page: Page, profile: 'cadu' | 'vanessa') {
  const response = await page.request.post('/api/v1/auth/login', {
    headers,
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBeTruthy();
}

async function mockLists(page: Page, queries: URLSearchParams[]) {
  await page.route('**/api/v1/lead-lists?*', (route) => {
    const query = new URL(route.request().url()).searchParams;
    queries.push(query);
    const category = query.get('category');
    return route.fulfill({
      json: {
        rows: category === 'ALL' || category === 'ATTENDED' ? [row] : [],
        counts,
        total: category === 'ALL' ? counts.ALL : counts[category as keyof typeof counts],
        page: 1,
        page_size: 30,
      },
    });
  });
}

test('consultor acessa listas rápidas sem filtro de outros atendentes', async ({ page }) => {
  await login(page, 'vanessa');
  const queries: URLSearchParams[] = [];
  await mockLists(page, queries);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#lists');

  await expect(page.getByRole('heading', { level: 1, name: 'Listas' })).toBeVisible();
  await expect(page.getByLabel('Filtrar por consultor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Abrir ficha de Lead da lista' })).toBeVisible();
  await page.getByRole('button', { name: /Compareceram 2/ }).click();
  await expect.poll(() => queries.at(-1)?.get('category')).toBe('ATTENDED');
  await expect(page.getByRole('button', { name: 'Abrir ficha de Lead da lista' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/lead-lists-mobile.png', animations: 'disabled' });
});

test('master vê toda a equipe e pode selecionar um consultor', async ({ page }) => {
  await login(page, 'cadu');
  const queries: URLSearchParams[] = [];
  await mockLists(page, queries);
  await page.goto('/#lists');

  const owner = page.getByLabel('Filtrar por consultor');
  await expect(owner).toBeVisible();
  const option = await owner.locator('option').nth(1).getAttribute('value');
  expect(option).toBeTruthy();
  await owner.selectOption(option!);
  await expect.poll(() => queries.at(-1)?.get('owner')).toBe(option);
  await expect(page.getByText('Lead da lista', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/lead-lists-manager.png', animations: 'disabled' });
});
