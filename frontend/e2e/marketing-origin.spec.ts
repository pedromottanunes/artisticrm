import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block', timezoneId: 'America/Sao_Paulo' });

async function login(page: Page, profile: 'cadu' | 'vanessa') {
  const response = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(response.ok()).toBe(true);
  return (await page.request.get('/api/v1/workspace')).json();
}

for (const profile of ['cadu', 'vanessa'] as const) {
  test(`origem textual no desktop e celular, custos sob demanda para ${profile}`, async ({
    page,
  }) => {
    const workspace = await login(page, profile);
    const lead = workspace.opportunities.find(
      (item: { state: string; owner_id: string }) =>
        item.state === 'CLAIMED' && (profile === 'cadu' || item.owner_id === workspace.user.id),
    );
    expect(lead).toBeTruthy();
    await page.route('**/api/v1/lead-lists?*', (route) =>
      route.fulfill({
        json: {
          rows: [lead],
          counts: { ALL: 1 },
          total: 1,
          page: 1,
          page_size: 30,
        },
      }),
    );
    await page.route(`**/api/v1/opportunities/${lead.id}`, async (route) => {
      const response = await route.fetch();
      return route.fulfill({
        json: {
          ...(await response.json()),
          channel: 'instagram',
          can_edit: true,
          acquisition: { kind: 'paid', ad_id: '111', occurred_at: '2026-09-23T15:00:00Z' },
          attributions: [],
          marketing_ads: [
            {
              ad_id: '111',
              ad_name: 'Resultado Carlos',
              campaign_name: 'Campanha clínica',
              adset_name: 'Região Sul',
              post_url: 'https://www.instagram.com/p/CARLOS/',
              checked_at: '2026-09-23T16:00:00Z',
              reference_text: 'Referência textual da publicação',
            },
          ],
        },
      });
    });
    let costs = 0;
    await page.route(`**/api/v1/opportunities/${lead.id}/acquisition-performance`, (route) => {
      costs++;
      return route.fulfill({
        json: {
          period: { from: '2026-09-01', to: '2026-09-23' },
          coverage_complete: true,
          performance: {
            spend: 300,
            currency: 'BRL',
            cpl: 20,
            attributed_leads: 15,
            scheduled: 5,
            attended: 4,
            sales: 1,
          },
        },
      });
    });
    await page.goto('/#lists');
    await page.getByRole('button', { name: `Abrir ficha de ${lead.name}` }).click();
    const origin = page.getByRole('region', { name: 'Origem do lead' });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await origin.scrollIntoViewIfNeeded();
      await expect(origin.getByText('Resultado Carlos', { exact: true })).toBeVisible();
      await expect(origin.getByText('Campanha clínica', { exact: true })).toBeVisible();
      await expect(origin.getByRole('link', { name: /Publicação vinculada/ })).toHaveAttribute(
        'href',
        'https://www.instagram.com/p/CARLOS/',
      );
      await expect(origin.locator('img,video,iframe,audio')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
    expect(costs).toBe(0);
    if (profile === 'cadu') {
      await origin.locator('summary').click();
      await expect(origin.getByText('Custo médio por lead', { exact: true })).toBeVisible();
      await expect(origin.getByText(/Período: 01 de set\. a 23 de set\./)).toBeVisible();
      expect(costs).toBe(1);
    } else await expect(origin.locator('summary')).toHaveCount(0);
    await page.screenshot({
      path: `test-results/marketing-origin-${profile}.png`,
      animations: 'disabled',
    });
  });
}

test('origem preserva o link recebido sem catálogo e rejeita URLs inseguras', async ({ page }) => {
  const workspace = await login(page, 'vanessa');
  const lead = workspace.opportunities.find(
    (item: { state: string; owner_id: string }) =>
      item.state === 'CLAIMED' && item.owner_id === workspace.user.id,
  );
  expect(lead).toBeTruthy();
  await page.route('**/api/v1/lead-lists?*', (route) =>
    route.fulfill({
      json: {
        rows: [lead],
        counts: { ALL: 1 },
        total: 1,
        page: 1,
        page_size: 30,
      },
    }),
  );
  const referral = 'https://www.instagram.com/p/REFERENCIA/';
  const publication = 'https://www.instagram.com/p/PUBLICACAO/';
  let post: string | null | undefined;
  let urls: (string | null)[] = [referral];
  await page.route(`**/api/v1/opportunities/${lead.id}`, async (route) => {
    const response = await route.fetch();
    return route.fulfill({
      json: {
        ...(await response.json()),
        channel: 'instagram',
        can_edit: true,
        acquisition: { kind: 'paid', ad_id: '111', occurred_at: '2026-09-23T15:00:00Z' },
        marketing_ads:
          post === undefined ? [] : [{ ad_id: '111', ad_name: 'Anúncio teste', post_url: post }],
        attributions: urls.map((url, index) => ({
          id: `ref-${index}`,
          source_id: '111',
          source_url: url,
          headline: 'Referência recebida',
          received_at: '2026-09-23T15:00:00Z',
        })),
      },
    });
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const scenario of [
      { post: undefined, urls: [referral], href: referral },
      { post: null, urls: [null, referral], href: referral },
      { post: publication, urls: [referral], href: publication },
      { post: 'javascript:alert(1)', urls: [referral], href: referral },
      {
        post: null,
        urls: [
          'javascript:alert(1)',
          'data:text/html,test',
          'https://user:secret@example.test/',
          '//example.test/',
        ],
        href: null,
      },
    ]) {
      post = scenario.post;
      urls = scenario.urls;
      await page.goto('/#lists');
      await page.getByRole('button', { name: `Abrir ficha de ${lead.name}` }).click();
      const origin = page.getByRole('region', { name: 'Origem do lead' });
      await origin.scrollIntoViewIfNeeded();
      if (scenario.href) {
        const link = origin.getByRole('link');
        await expect(link).toHaveAttribute('href', scenario.href);
        await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        await expect(link).toHaveText(
          scenario.href === publication
            ? 'Publicação vinculada ao anúncio'
            : 'Abrir referência enviada pela Meta',
        );
      } else await expect(origin.getByRole('link')).toHaveCount(0);
      await expect(origin.locator('img,video,iframe,audio')).toHaveCount(0);
      await expect(origin.locator('summary')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toBeHidden();
    }
  }
});

test('relatório abre lista do anúncio só no clique e solicita atualização em segundo plano', async ({
  page,
}) => {
  await login(page, 'cadu');
  await page.route('**/api/v1/meta-marketing/status', (route) =>
    route.fulfill({ json: { configured: true, state: 'idle' } }),
  );
  await page.route('**/api/v1/reports/meta-ads?*', (route) =>
    route.fulfill({
      json: {
        currency: 'BRL',
        spend: 300,
        eligible_spend: 300,
        cpl: 20,
        instagram_leads: 15,
        identified_paid_leads: 15,
        matched_attributed_leads: 15,
        unmatched_attributed_leads: 0,
        unattributed_or_organic_leads: 0,
        coverage_complete: true,
        total: 1,
        ads: [
          {
            ad_id: '111',
            ad_name: 'Resultado Carlos',
            campaign_name: 'Campanha clínica',
            scope: 'instagram_direct',
            spend: 300,
            currency: 'BRL',
            attributed_leads: 15,
            scheduled: 5,
            attended: 4,
            sales: 1,
            sales_value: 12000,
            cpl: 20,
            cost_per_sale: 300,
          },
        ],
      },
    }),
  );
  let lists = 0;
  await page.route('**/api/v1/reports/meta-ads/leads?*', (route) => {
    lists++;
    expect(new URL(route.request().url()).searchParams.get('ad_id')).toBe('111');
    return route.fulfill({
      json: {
        items: [
          {
            id: '10000000-0000-4000-8000-000000000001',
            name: 'João teste',
            owner_name: 'Consultor teste',
          },
        ],
        next_cursor: null,
      },
    });
  });
  await page.route('**/api/v1/meta-marketing/sync', (route) => {
    expect(route.request().postDataJSON()).toMatchObject({
      from: expect.any(String),
      to: expect.any(String),
    });
    return route.fulfill({ status: 202, json: { queued: true } });
  });
  await page.goto('/#reports');
  await expect(page.getByText('Resultado Carlos', { exact: true })).toBeVisible();
  expect(lists).toBe(0);
  await page.getByRole('button', { name: 'Ver 15 leads de Resultado Carlos' }).click();
  await expect(page.getByRole('dialog').getByText('João teste')).toBeVisible();
  // Development StrictMode can start then abort the first mount request.
  expect(lists).toBeGreaterThanOrEqual(1);
  expect(lists).toBeLessThanOrEqual(2);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Sincronizar anúncios' }).click();
  await expect(page.getByText(/Atualização agendada/)).toBeVisible();
});
