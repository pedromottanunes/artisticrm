import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

for (const scenario of ['normal', 'demonstração', 'somente leitura']) {
  const isDemo = scenario === 'demonstração';
  test(`telefone do lead: WhatsApp ${scenario}`, async ({ page }) => {
    const response = await page.request.post('/api/v1/auth/login', {
      headers: { 'X-Artisti-Client': 'web' },
      data: { login: 'vanessa@demo.artisti.local', password: 'Artisti.demo2026!' },
    });
    expect(response.ok()).toBe(true);
    const workspace = await (await page.request.get('/api/v1/workspace')).json();
    const lead = workspace.opportunities.find(
      (item: { state: string; owner_id: string }) =>
        item.state === 'CLAIMED' && item.owner_id === workspace.user.id,
    );
    expect(lead).toBeTruthy();
    let mutations = 0;
    let savedPhone = '+55 (48) 99999-9999';
    await page.route(`**/api/v1/opportunities/${lead.id}`, async (route) => {
      if (route.request().method() === 'PATCH') {
        mutations++;
        savedPhone = route.request().postDataJSON().phone;
        return route.fulfill({ json: { ok: true } });
      }
      const result = await route.fetch();
      const detail = await result.json();
      // UI-only fixture; never navigate to WhatsApp or contact a real number.
      return route.fulfill({
        response: result,
        json: {
          ...detail,
          is_demo: isDemo,
          can_edit: scenario !== 'somente leitura',
          channel: 'instagram',
          phone: savedPhone,
          version: detail.version + mutations,
        },
      });
    });
    await page.goto('/');
    await page.getByRole('button', { name: `Abrir ficha de ${lead.name}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    const phone = dialog.getByRole('textbox', { name: 'Telefone', exact: true });
    const link = dialog.getByRole('link', { name: 'Abrir WhatsApp deste telefone' });
    const disabled = dialog.getByRole('button', { name: 'Abrir WhatsApp deste telefone' });
    if (scenario !== 'normal') {
      await expect(disabled).toBeDisabled();
      await expect(link).toHaveCount(0);
      return;
    }
    await expect(link).toHaveAttribute('href', 'https://wa.me/5548999999999');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    for (const invalid of [
      '',
      '123',
      '+55 abc 48999999999',
      '++5548999999999',
      '048999999999',
      'https://evil.example',
    ]) {
      await phone.fill(invalid);
      await expect(disabled).toBeDisabled();
      await expect(link).toHaveCount(0);
    }
    await phone.fill('+55 abc 48999999999');
    await dialog.getByRole('button', { name: 'Salvar cadastro' }).click();
    await expect(dialog.getByRole('alert')).toContainText('Informe um telefone com DDD');
    expect(mutations).toBe(0);
    for (const [input, digits] of [
      ['(48) 99999-9999', '5548999999999'],
      ['48 3333-4444', '554833334444'],
      ['(55) 99999-9999', '5555999999999'],
      ['5548999999999', '5548999999999'],
      ['+1 (415) 555-2671', '14155552671'],
      ['+33 6 12 34 56 78', '33612345678'],
      ['+44 20 7946 0958', '442079460958'],
    ]) {
      await phone.fill(input);
      await expect(link).toHaveAttribute('href', `https://wa.me/${digits}`);
    }
    await phone.fill('+55 (11) 98888-8888');
    await expect(link).toHaveAttribute('href', 'https://wa.me/5511988888888');
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await link.scrollIntoViewIfNeeded();
      const inputBox = (await phone.boundingBox())!;
      const linkBox = (await link.boundingBox())!;
      expect(linkBox.x).toBeGreaterThanOrEqual(inputBox.x + inputBox.width);
      expect(linkBox.x + linkBox.width).toBeLessThanOrEqual(width);
      expect(linkBox.width).toBeGreaterThanOrEqual(44);
      expect(linkBox.height).toBeGreaterThanOrEqual(44);
      expect(Math.abs(linkBox.y - inputBox.y)).toBeLessThanOrEqual(1);
    }
    await dialog.getByRole('button', { name: 'Consultas', exact: true }).click();
    await dialog.getByRole('button', { name: 'Cadastro comercial', exact: true }).click();
    await expect(phone).toHaveValue('+55 (48) 99999-9999');
    await expect(link).toHaveAttribute('href', 'https://wa.me/5548999999999');
    expect(mutations).toBe(0);
    // Simulate persistence without writing to the database. Saving must agree with
    // the live link, and reloading must not prepend 55 to international numbers.
    for (const [input, digits] of [
      ['(48) 99999-9999', '5548999999999'],
      ['+1 (415) 555-2671', '14155552671'],
      ['+33 6 12 34 56 78', '33612345678'],
    ]) {
      await phone.fill(input);
      await dialog.getByRole('button', { name: 'Salvar cadastro' }).click();
      await expect(phone).toHaveValue(`+${digits}`);
      await expect(link).toHaveAttribute('href', `https://wa.me/${digits}`);
      expect(savedPhone).toBe(digits);
    }
  });
}
