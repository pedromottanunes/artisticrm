import { test, expect, type Page } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

async function openLead(page: Page, profile = 'vanessa') {
  const login = await page.request.post('/api/v1/auth/login', {
    headers: { 'X-Artisti-Client': 'web' },
    data: { login: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' },
  });
  expect(login.ok()).toBe(true);
  const workspace = await (await page.request.get('/api/v1/workspace')).json();
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
  let patches = 0;
  await page.route(`**/api/v1/opportunities/${lead.id}`, async (route) => {
    if (route.request().method() === 'PATCH') {
      patches++;
      expect(route.request().postDataJSON().phone).toBe('5548999999999');
      return route.fulfill({ json: {} });
    }
    const response = await route.fetch();
    return route.fulfill({
      json: { ...(await response.json()), can_edit: true, sale_completed_at: null },
    });
  });
  await page.goto('/#lists');
  await page.getByRole('button', { name: `Abrir ficha de ${lead.name}` }).click();
  return { dialog: page.getByRole('dialog'), patches: () => patches };
}

async function mockViewport(page: Page) {
  await page.addInitScript(() => {
    const viewport = window.visualViewport!;
    const height = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(viewport), 'height')!.get!;
    let override: number | undefined;
    Object.defineProperty(viewport, 'height', { get: () => override ?? height.call(viewport) });
    window.addEventListener('test:keyboard', (event) => {
      override = (event as CustomEvent<number>).detail || undefined;
      viewport.dispatchEvent(new Event('resize'));
    });
  });
}
async function keyboard(page: Page, height: number) {
  await page.evaluate(
    (height) => window.dispatchEvent(new CustomEvent('test:keyboard', { detail: height })),
    height,
  );
}

for (const profile of ['vanessa', 'cadu']) {
  test(`ficha mobile mantém telefone visível e salva pelo topo: ${profile}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockViewport(page);
    const { dialog, patches } = await openLead(page, profile);
    const phone = dialog.getByRole('textbox', { name: 'Telefone', exact: true });
    await expect(dialog.getByRole('button', { name: 'Salvar cadastro', exact: true })).toHaveCount(
      1,
    );
    await expect(dialog.getByRole('button', { name: 'Registrar venda' })).toBeHidden();
    await phone.fill('(48) 99999-9999');
    await expect(dialog).toHaveAttribute('data-keyboard-open', 'false');
    await page.screenshot({ path: `test-results/lead-mobile-${profile}.png` });
    await keyboard(page, 410);
    await expect(dialog).toHaveAttribute('data-keyboard-open', 'true');
    await expect(dialog.locator('.commercial-actions')).toBeHidden();
    await expect(dialog.locator('.detail-tabs')).toBeHidden();
    await expect(dialog.locator('.lead-keyboard-save')).toBeVisible();
    await expect
      .poll(async () => {
        const input = await phone.boundingBox();
        const scroll = await dialog.locator('.lead-form-scroll').boundingBox();
        return (
          !!input &&
          !!scroll &&
          input.y >= scroll.y &&
          input.y + input.height <= scroll.y + scroll.height &&
          input.y + input.height <= 410
        );
      })
      .toBe(true);
    await page.screenshot({ path: `test-results/lead-keyboard-${profile}.png` });
    await keyboard(page, 0);
    await expect(dialog.locator('.commercial-actions')).toBeVisible();
    await expect(phone).toHaveValue('(48) 99999-9999');
    await phone.focus();
    await keyboard(page, 410);
    await dialog.getByRole('button', { name: 'Salvar cadastro', exact: true }).click();
    await expect.poll(patches).toBe(1);
  });
}

test('ações secundárias no menu, sem fechar ficha com Escape; desktop preservado', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await openLead(page);
  const menu = dialog.locator('.lead-mobile-menu');
  await menu.getByLabel('Mais ações do lead').click();
  await expect(menu.getByRole('button', { name: 'Registrar venda' })).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Copiar para WhatsApp' })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(menu).not.toHaveAttribute('open');
  for (const width of [320, 390, 760]) {
    await page.setViewportSize({ width, height: 844 });
    const box = await dialog.boundingBox();
    expect(box!.width).toBe(width);
    expect(box!.y).toBe(0);
    expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(dialog.locator('.lead-mobile-toolbar')).toBeHidden();
  await expect(
    dialog.locator('.commercial-actions').getByRole('button', { name: 'Registrar venda' }),
  ).toBeVisible();
  await expect(
    dialog.locator('.commercial-actions').getByRole('button', { name: 'Copiar para WhatsApp' }),
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Salvar cadastro', exact: true })).toHaveCount(1);
});

test('validação no celular fica visível com teclado e preserva o preenchimento', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockViewport(page);
  const { dialog, patches } = await openLead(page);
  const phone = dialog.getByRole('textbox', { name: 'Telefone', exact: true });
  await phone.fill('123');
  await keyboard(page, 410);
  await dialog.getByRole('button', { name: 'Salvar cadastro', exact: true }).click();
  const error = dialog.getByRole('alert');
  await expect(error).toContainText('Informe um telefone com DDD');
  await expect(error).toBeInViewport();
  expect((await error.boundingBox())!.y + (await error.boundingBox())!.height).toBeLessThanOrEqual(
    410,
  );
  await expect(phone).toHaveValue('123');
  expect(patches()).toBe(0);
});
