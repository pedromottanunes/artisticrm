# Artisti CRM

Primeira versão executável do CRM: interface de gestão e atendimento, API e banco persistente. Ainda é uma **versão de desenvolvimento/homologação**, não está pronta para operar com pacientes. A integração da central WhatsApp está implementada, mas desligada e sem credenciais; Meta Ads, Google Ads, GTM e push ainda não estão conectados. Consulte [WHATSAPP.md](WHATSAPP.md) para ativar posteriormente no Render.

## Distribuição e bolsão: fluxo acordado

- Novos leads percorrem o rodízio das atendentes ativas e habilitadas para recebimento automático.
- A reserva dura dez minutos por padrão, contados pelo servidor. O prazo configurável só altera reservas futuras.
- Sem aceite até o vencimento, o lead fica disponível no bolsão para **todas as atendentes com conta ativa**, mesmo pausadas no rodízio. Contas desativadas não têm acesso.
- O primeiro aceite confirmado pelo banco ganha o lead. Cliques concorrentes não criam dois responsáveis; repetir a mesma solicitação após falha de rede não duplica o aceite.
- Somente após assumir o contato é liberado para abrir o WhatsApp. Isso abre o contato na conta disponível no aparelho/Web; não transfere o histórico da central nem confirma envio de mensagem.
- O processo periódico e as consultas reconciliam reservas vencidas; o próprio aceite também verifica o prazo. Reiniciar o servidor não reinicia o cronômetro.
- A entrada da central tem webhook assinado, fila persistente, deduplicação e novas tentativas; permanece desligada até configurar a Meta e o ambiente. Notificações push ainda não estão implementadas. O fluxo pode ser verificado com cadastros manuais e testes automatizados, sem enviar mensagens.

## Executar localmente

Requisito: Node.js 22.12+ (validado com 22.18) e npm.

```bash
npm ci
npm run dev
```

Abra **http://127.0.0.1:5173**. Escolha Cadu para gestão ou uma atendente para testar o atendimento. Os acessos de demonstração só aparecem no frontend de desenvolvimento; a versão compilada usa e-mail e senha.

- Frontend: porta 5173. API: porta 3333, ambas restritas à máquina local.
- Banco local: PostgreSQL embarcado (PGlite) em `backend/.data/postgres`. Persiste entre reinícios; não é versionado. Apenas um processo de desenvolvimento deve abrir esse diretório.
- Dados iniciais: contatos fictícios, reservas, bolsão, agendamentos e quatro atendentes. São criados uma única vez no banco vazio. O prazo das reservas continua correndo mesmo sem o navegador aberto.
- `DATABASE_URL` permite usar PostgreSQL externo de desenvolvimento. Não aponte o desenvolvimento para o banco publicado: o seed local é exclusivo de teste.
- Os exemplos `.env.example` documentam variáveis; nesta etapa, o processo lê o ambiente do terminal/Render e não carrega arquivos `.env` automaticamente.
- Contatos fictícios não abrem WhatsApp. Cadastros manuais podem abrir o contato após aceite, por ação explícita da atendente. O CRM não envia mensagens.

## O que já funciona

- Login por sessão, logout, autorização de gestão/atendimento e proteção dos telefones no bolsão.
- Gestão: indicadores calculados da base, pesquisa e filtro de leads, ficha editável, funil, agenda e configuração do rodízio.
- Atendimento: meus leads, bolsão, aceite no servidor e abertura externa do WhatsApp para contatos não fictícios.
- Rodízio transacional, prazo configurável, vencimento persistente, disputa com um vencedor e repetição segura do aceite.
- Deduplicação de cadastro/entrada, histórico de eventos e agendamento de avaliações.
- Cadastro de atendentes pela gestão, desativação/reativação e redefinição de senha temporária. Primeiro acesso exige troca de senha; troca/redefinição revoga sessões anteriores.
- Desativação com substituta obrigatória quando houver atendimentos ou reservas abertas, transferidos na mesma transação.
- Transferência administrativa com motivo, versão e idempotência, sem alterar o rodízio nem contar como aceite da atendente.
- Remarcação, cancelamento e conclusão de avaliações com histórico. Avaliação futura não pode ser concluída; avaliação já encerrada não pode ser reescrita.
- Retornos após oportunidade encerrada criam uma nova pendência de revisão. A gestão atribui essa oportunidade pela ficha; o histórico anterior permanece separado.
- Reconciliação de reservas a cada 5 segundos e nas consultas; o aceite também valida o prazo, sem depender da rotina periódica.
- Layout responsivo, logo original e tema azul-marinho/dourado da Artisti.
- Áreas Meta Ads/Google Ads com estado **não conectado**, sem métricas de mídia inventadas.

Não implementado: sincronização de anúncios, instrumentação do site/GTM, push/PWA, contratos e comissões, upload de documentos, recuperação autônoma de senha por e-mail, convites por link, MFA e administração de perfis de gestão. A central exige configuração e homologação com a Meta. A lista inicial possui limite de 500 oportunidades por consulta; paginação e relatórios por período ainda precisam ser implementados. Não usar esta etapa como sistema de produção.

### Regras operacionais implementadas, sujeitas à validação do cliente

- Pausar o rodízio preserva as reservas atuais; desativar o acesso revoga as sessões e exige substituir o responsável pelos atendimentos abertos.
- Reativar não devolve leads antigos nem habilita automaticamente o rodízio.
- Atribuir pela gestão libera o contato para a nova responsável imediatamente. `claimed_at` fica vazio, distinguindo transferência administrativa de aceite.
- Retorno de contato encerrado exige revisão manual; não se reabre nem se sobrescreve a oportunidade antiga.
- Uma oportunidade só pode receber uma nova avaliação se não tiver outra agendada. Remarcação mantém o mesmo registro e guarda antes/depois na auditoria.
- Cancelar/concluir avaliação não muda automaticamente o funil comercial. É preciso cancelar/concluir avaliações abertas antes de encerrar o lead como perdido.
- Senhas temporárias são entregues fora do CRM por canal seguro; não há envio automático de credenciais. Para acessar contas criadas localmente, use **Usar e-mail e senha** na tela de login.

Essas escolhas são conservadoras para teste técnico, não substituem a confirmação das regras operacionais com Cadu.

## GitHub e Render

O repositório mantém `backend/` e `frontend/` separados. O deploy inicial usa **um Web Service Node que serve frontend compilado + API**, com **PostgreSQL separado**. Não depende do disco temporário do Web Service e não requer CORS entre dois domínios.

Consulte [DEPLOY.md](DEPLOY.md) e [render.yaml](render.yaml). O blueprint está preparado para homologação e contém recursos pagos; revise os planos antes de aplicar. Nenhum repositório remoto, serviço, banco pago ou deploy foi criado por esta implementação.

No ambiente publicado, o banco começa vazio, exige credenciais próprias e não carrega os perfis fictícios. O bootstrap cria apenas a conta de gestão; o cadastro operacional das atendentes está documentado em [DEPLOY.md](DEPLOY.md).

## Verificar a implementação

```bash
npm run typecheck
npm test
npm run build
npm run test:release
npx playwright install chromium
npm run test:e2e
```

- Testes do backend: distribuição, duplicidade, concorrência, prazo, permissões, idempotência, agenda e persistência.
- Cobertura operacional adicional: transferência concorrente com aceite, revogação de acesso durante trabalho, reentrada em revisão, remarcação auditada, senhas temporárias e rejeição de aceite antigo após transferência.
- Teste de release: frontend compilado servido pela API, CSP, cookies seguros e ausência das credenciais demo no bundle.
- Testes de navegador: gestão, cadastro, edição, agendamento e atendimento em viewport móvel. Usam banco temporário em memória e portas 5175/3335, sem alterar a base de desenvolvimento.
- A CI do GitHub também executa os testes em PostgreSQL 18. Essa etapa será executada no GitHub; o resultado local em PGlite não substitui o teste de concorrência em PostgreSQL externo.
- A validação de navegador não substitui testes em iPhones/Android físicos, especialmente para WhatsApp e futuras notificações.

`npm run format` formata o código. `package-lock.json` deve ser versionado; `node_modules`, `.env`, `.data`, builds e resultados de testes ficam fora do Git.

## Organização

```text
ARTISTI CRM/
├── README.md
├── DEPLOY.md
├── render.yaml
├── package.json
├── package-lock.json
├── .github/workflows/ci.yml
├── backend/
│   ├── src/
│   ├── migrations/
│   ├── test/
│   ├── ESPECIFICACAO.md
│   └── CONTRATO-API.md
└── frontend/
    ├── src/
    ├── public/
    ├── e2e/
    └── ESPECIFICACAO.md
```

- [Backend: regras, dados, integrações e operação](backend/ESPECIFICACAO.md)
- [Contrato proposto entre backend e frontend](backend/CONTRATO-API.md)
- [Frontend: telas, navegação e identidade visual](frontend/ESPECIFICACAO.md)

## Escopo confirmado

As seções seguintes preservam o planejamento completo. Elas descrevem também etapas futuras, não apenas o que está implementado nesta versão.

Uma plataforma da Artisti, com área de gestão e área das atendentes. Ambas acessíveis pelo navegador; a área das atendentes prioriza celular e também funciona em desktop.

1. O paciente envia mensagem ao WhatsApp central, que não responde a ninguém.
2. O backend registra o contato e distribui oportunidades novas em rodízio.
3. A atendente recebe uma reserva na sua área e pode assumir.
4. Encerrado o prazo sem aceite, o lead fica disponível no bolsão.
5. A primeira atendente que tiver o aceite confirmado pelo servidor assume.
6. O aplicativo disponibiliza a abertura do WhatsApp da atendente para conversar com o paciente.
7. Cadastro, próximas ações, agendamentos e andamento comercial são atualizados no CRM.
8. Gestão acompanha atendimento, contratos, comissões e resultados de aquisição.

Não fazem parte da primeira versão: chat interno, integração com Instagram Direct, chatbot, análise de conversas por IA, Coexistência nos números das atendentes, prontuário médico ou edição de campanhas de mídia.

Instagram pode existir como campo opcional do cadastro. Meta Ads e Google Ads são integrações de relatórios, distintas da integração de entrada do WhatsApp.

## Decisões propostas, sujeitas à validação

| Tema | Proposta inicial |
| --- | --- |
| Prazo | Dez minutos corridos desde a disponibilização da reserva; configurável |
| Ordem | Vanessa → Priscila → Vitória → Calel; confirmar nomes e ordem |
| Participação | Atendentes habilitadas pelo gestor; não depende de presença online |
| Filas | Uma fila compartilhada; unidade cadastrada sem criar filas separadas automaticamente |
| Reentrada | Oportunidade aberta mantém responsável; retorno após encerramento precisa de política validada |
| Aceite | Registra posse e tempo até aceite; não comprova primeira mensagem enviada |
| Instalação | PWA candidata; aplicativo de loja depende dos testes nos celulares e decisão de distribuição |
| Tecnologia | React/TypeScript, API Node.js/Fastify, PostgreSQL, worker com pg-boss |
| Serviços gerenciados | Supabase candidato para banco, autenticação e arquivos privados |

## Entregas e critérios de avanço

### 1. Descoberta e prova técnica

- Observar o aplicativo atual para confirmar reserva, aceite, bolsão e reentrada.
- Levantar aparelhos, sistemas operacionais, volume de leads e picos.
- Confirmar titularidade e situação do número central e acessos às contas autorizadas.
- Confirmar unidades atendidas, contratos, regra de comissão e dados a importar do sistema atual.
- Depois de autorizado o desenvolvimento: testar entrada oficial em ambiente de teste, notificações e abertura do WhatsApp nos aparelhos reais.
- Conclusão: regras documentadas e fluxo móvel validado; escolher PWA ou aplicativo de loja.

### 2. Distribuição e atendimento

- Implementar login, cadastro, rodízio, reserva, bolsão, aceite, histórico e notificações.
- Critérios: eventos repetidos não duplicam oportunidades; quatro aceites simultâneos geram um vencedor; reinícios não perdem reservas; interface recupera estado após falha de rede.

### 3. Comercial

- Implementar próximas ações, avaliações, funil, contratos e apuração de comissões.
- Critérios: assinatura validada antes de liberar comissão; histórico financeiro preservado em transferências posteriores; permissões verificadas no servidor.

### 4. Aquisição e resultados

- Instrumentar as duas landing pages com GTM e referência de clique.
- Integrar relatórios de Meta Ads e Google Ads e exibir cobertura de atribuição.
- Critérios: clique sem mensagem não cria lead; campanha sem evidência não é atribuída por aproximação; sincronização de mídia não bloqueia distribuição.

### 5. Operação assistida e migração

- Importar dados com conferência de responsáveis, oportunidades e valores.
- Testar restauração do banco e recuperação dos arquivos separadamente.
- Planejar migração do número e da operação segundo a integração existente, sem assumir conexão simultânea com dois distribuidores.
- Apenas um sistema distribui leads de produção; registrar plano de retorno antes da virada.

## Métricas e limites

- Cliques, contatos, oportunidades e aceites são contagens diferentes.
- Tempo de aceite não deve ser rotulado como tempo de primeira resposta.
- Receita contratada e valores recebidos são indicadores diferentes.
- Custo por lead e ROAS usam bases e regras de atribuição explícitas, incluindo a data de aquisição.
- Não presumir origem orgânica quando faltar rastreamento.
- Não enviar conversões médicas às plataformas automaticamente; relatórios internos são independentes dessa eventual exportação.

## Referências já verificadas na conversa

- Site de referência visual: https://artistitransplantecapilar.com.br/
- Tema: https://artistitransplantecapilar.com.br/wp-content/uploads/elementor/css/post-7.css
- Entrada WhatsApp: https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message
- Referência de anúncio WhatsApp: https://www.postman.com/meta/whatsapp-business-platform/request/g7sv9jo/received-message-triggered-by-click-to-whatsapp-ads
- Web Push no iPhone: https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/
- Distribuição não listada na App Store: https://developer.apple.com/support/unlisted-app-distribution/
- Política de dados Google Ads: https://support.google.com/google-ads/answer/7475709?hl=en

## Pendências que afetam implementação

- Nome do CRM atual e demonstração do fluxo, inclusive se o vendedor original pode disputar o bolsão.
- Confirmação do prazo, das exceções fora de horário e do procedimento quando ninguém assume.
- Política de retorno após oportunidade encerrada, duplicidades, telefones compartilhados e mudanças de número.
- Forma de cadastro manual e se novos cadastros manuais entram no rodízio ou recebem responsável explícito.
- Contratos, critérios de comissão, cancelamentos e estornos.
- Autorização técnica das contas: possuir chaves não basta sem permissões sobre os ativos da Artisti.
- Publicação em loja ou PWA; experiência com notificações e escolha do WhatsApp Business nos aparelhos reais.
- Hospedagem, retenção, recuperação e suporte: metas a definir com o cliente, sem promessa de disponibilidade nesta especificação.
