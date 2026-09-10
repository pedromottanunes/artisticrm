import { test, expect, type Page } from '@playwright/test';

test('gestão consulta central desligada em viewport móvel sem expor configuração', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  // Navigate through the desktop-sized menu first, then inspect the same panel on mobile.
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const panel = page.locator('section').filter({ has: page.getByRole('heading', { name: 'WhatsApp central', exact: true }) });
  await expect(panel.getByText('Desligado', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await expect(panel.getByText('A central não envia respostas.', { exact: false })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
async function login(page: Page, profile = 'cadu') {
  await page.goto('/');
  await page.getByLabel('Escolha um perfil de demonstração').selectOption(profile);
  await page.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}
test('gestão navega, filtra e cadastra lead persistente', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await login(page);
  await expect(page.getByText('Seu relacionamento,')).toBeVisible();
  await page.screenshot({ path: 'test-results/gestao-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Novo lead', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome do contato').fill('Teste Navegador');
  await dialog.getByLabel('WhatsApp com país e DDD').fill(`5548${String(Date.now()).slice(-9)}`);
  await dialog.getByRole('button', { name: 'Cadastrar e distribuir' }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Teste Navegador');
  await expect(page.getByRole('table').getByText('Teste Navegador').first()).toBeVisible();
  await page.getByRole('button', { name: 'Meta Ads', exact: true }).click();
  await expect(page.getByText('Não conectado').first()).toBeVisible();
  expect(errors).toEqual([]);
});
test('atendimento móvel acessa bolsão e confirma aceite sem abrir contato fictício', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'vanessa');
  await expect(page.getByRole('heading', { name: /Olá, Vanessa/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Atalhos de atendimento' })
    .getByRole('button', { name: 'Bolsão' })
    .click();
  await expect(page.getByRole('heading', { name: 'Bolsão', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/atendimento-mobile.png', fullPage: true });
  const claim = page.getByRole('button', { name: 'Assumir lead' }).first();
  await expect(claim).toBeVisible();
  await claim.click();
  await expect(page.getByRole('status').filter({ hasText: 'Contato fictício' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page
    .getByRole('navigation', { name: 'Atalhos de atendimento' })
    .getByRole('button', { name: 'Meus leads' })
    .click();
  await expect(page.getByText('WhatsApp', { exact: true }).first()).toBeVisible();
});
test('ficha edita cadastro, agenda avaliação e preserva histórico', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Gustavo Pereira');
  await page.getByRole('button', { name: 'Abrir ficha de Gustavo Pereira' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Próxima ação').fill('Retorno de teste agendado');
  await dialog.getByRole('button', { name: 'Salvar alterações' }).click();
  await expect(dialog.getByRole('button', { name: 'Salvar alterações' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Agendar avaliação', exact: true }).click();
  await dialog.getByLabel('Data e horário').fill('2027-10-01T15:30');
  await dialog.getByRole('button', { name: 'Confirmar avaliação' }).click();
  await expect(dialog.getByText(/Avaliação agendada por Cadu/).first()).toBeVisible();
  await dialog.getByRole('button', { name: 'Avaliações', exact: true }).click();
  await dialog.getByRole('button', { name: 'Alterar avaliação' }).click();
  await dialog.getByLabel('Ação na avaliação').selectOption('cancelled');
  await dialog.getByLabel('Motivo', { exact: true }).fill('Cancelamento solicitado no teste');
  await dialog.getByRole('button', { name: 'Salvar avaliação' }).click();
  await expect(dialog.getByText(/· Cancelada/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(dialog.getByText(/Avaliação cancelada/)).toBeVisible();
});
test('painel móvel sem transbordamento e menu utilizável', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await login(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Abrir menu' }).click();
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: 'Google Ads', exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name: 'Google Ads' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('gestão cria atendente e primeiro acesso obriga troca de senha', async ({ page, browser }) => {
  await login(page);
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  await page.getByRole('button', { name: 'Nova atendente', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nome da atendente').fill('Atendente E2E');
  await dialog.getByLabel('E-mail de acesso').fill('atendente-e2e@example.test');
  await dialog.getByLabel('Senha temporária').fill('Ab!123');
  await dialog.getByRole('button', { name: 'Confirmar alteração' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Atendente E2E', { exact: true })).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/equipe-mobile.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:1280,height:720});
  const context = await browser.newContext();
  const attendant = await context.newPage();
  try {
    await attendant.goto('/');
    await attendant.getByRole('button', { name: 'Usar e-mail e senha' }).click();
    await attendant.getByLabel('E-mail', { exact: true }).fill('atendente-e2e@example.test');
    await attendant.getByLabel('Senha', { exact: true }).fill('Ab!123');
    await attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
    await expect(
      attendant.getByRole('heading', { name: 'Defina sua senha pessoal' }),
    ).toBeVisible();
    await attendant.getByLabel('Senha atual ou temporária').fill('Ab!123');
    await attendant.getByLabel('Nova senha', { exact: true }).fill('Cd!456');
    await attendant.getByLabel('Confirmar nova senha').fill('Cd!456');
    await attendant.getByRole('button', { name: 'Salvar nova senha' }).click();
    await expect(
      attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }),
    ).toBeVisible();
    await attendant.getByRole('button', { name: 'Usar e-mail e senha' }).click();
    await attendant.getByLabel('E-mail', { exact: true }).fill('atendente-e2e@example.test');
    await attendant.getByLabel('Senha', { exact: true }).fill('Cd!456');
    await attendant.getByRole('button', { name: 'Entrar no espaço de trabalho' }).click();
    await expect(attendant.getByRole('heading', { name: /Olá, Atendente E2E/ })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('gestão transfere lead e desativação redistribui os atendimentos', async ({ page }) => {
  await login(page);
  await page
    .getByRole('navigation', { name: 'Menu principal' })
    .getByRole('button', { name: /^Leads/ })
    .click();
  await page.getByLabel('Buscar nome ou telefone').fill('Rafael Almeida');
  await page.getByRole('button', { name: 'Abrir ficha de Rafael Almeida' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Atribuir / transferir' }).click();
  await dialog.getByLabel('Nova responsável').selectOption({ label: 'Priscila' });
  await dialog.getByLabel('Motivo da transferência').fill('Transferência de teste operacional');
  await dialog.getByRole('button', { name: 'Confirmar atribuição' }).click();
  await dialog.getByRole('button', { name: 'Histórico', exact: true }).click();
  await expect(dialog.getByText(/Atribuído pela gestão para Priscila/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Fechar janela' }).click();
  await page.getByRole('button', { name: 'Configurações', exact: true }).click();
  const member = page
    .locator('.team-list article')
    .filter({ has: page.getByText('Priscila', { exact: true }) });
  await member.getByRole('button', { name: 'Gerenciar' }).click();
  await dialog.getByLabel('Permitir acesso ao CRM').uncheck();
  await dialog
    .getByLabel('Destino dos atendimentos ao desativar')
    .selectOption({ label: 'Vitória' });
  await dialog.getByLabel('Motivo da alteração').fill('Desativação da conta no teste');
  await dialog.getByRole('button', { name: 'Confirmar alteração' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(member.getByText(/Acesso desativado/)).toBeVisible();
});
