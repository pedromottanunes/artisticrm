import { test, expect } from '@playwright/test';

test('política de privacidade é pública e identifica o tratamento do CRM', async ({ page }) => {
  await page.goto('/politica-de-privacidade');
  await expect(page.getByRole('heading', { name: 'Política de Privacidade' })).toBeVisible();
  await expect(page.getByText(/ARTISTI CRM poderá tratar/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'instruções para exclusão de dados' }),
  ).toHaveAttribute('href', '/exclusao-de-dados');
});

test('instruções de exclusão são públicas e não solicitam segredos', async ({ page }) => {
  await page.goto('/exclusao-de-dados');
  await expect(page.getByRole('heading', { name: 'Exclusão de dados' })).toBeVisible();
  await expect(page.getByText(/Nunca envie senha, token, código de autenticação/)).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Política de Privacidade do ARTISTI CRM/ }),
  ).toHaveAttribute('href', '/politica-de-privacidade');
});
