# Contrato proposto entre frontend e backend

Contrato-alvo; nem todas as rotas abaixo estão implementadas. Prefixo: `/api/v1`.

## Rotas da primeira entrega

Implementadas em `src/app.ts`: `POST /auth/login`, `POST /auth/logout`, `GET /me`, `GET /workspace` (snapshot autorizado, até 500 oportunidades), `POST /opportunities`, `GET/PATCH /opportunities/:id`, `POST /opportunities/:id/claim`, `POST /opportunities/:id/whatsapp-link`, `POST /opportunities/:id/appointments`, `PATCH /distribution/settings` e `GET /integrations/status`. Health check público: `GET /api/health`.

Nesta etapa, cadastro manual cria contato e oportunidade numa operação só; edição da ficha atualiza ambos com controle de versão. Histórico vem na ficha. Leituras em tempo real ainda são substituídas por consulta a cada 5 segundos; não há SSE/push ativo. A API exige cookie de sessão e `X-Artisti-Client: web` nas alterações, valida a origem do navegador e exige `Idempotency-Key` no cadastro/aceite. Integrações retornam `not_connected`, sem credenciais.

As rotas e convenções seguintes continuam como alvo das próximas etapas, inclusive paginação, `request_id` generalizado e módulos comerciais.

## Convenções

### Extensões operacionais implementadas

- `POST /users`: gestão cria atendente com `name`, `email`, `password` temporária e `queue_position` livre.
- `PATCH /users/:id`: gestão envia `name`, `active`, `expected_version`, `reason` e, para desligamento com trabalho aberto, `replacement_id`.
- `DELETE /users/:id`: gestão exclui permanentemente uma atendente já inativa e sem leads vinculados, com `expected_version` e confirmação `EXCLUIR`.
- `POST /users/:id/reset-password`: `password` temporária e `expected_version`; somente atendentes podem ser alvo desta rota.
- `POST /auth/password`: `current_password` e `new_password`; encerra todas as sessões após sucesso.
- `POST /opportunities/:id/transfer`: `target_id`, `expected_version`, `reason`; atribuição administrativa, não aceite.
- `PATCH /appointments/:id`: `expected_version`, `status`, `starts_at`, `unit`, `reason`. Para conclusão/cancelamento, servidor preserva horário/unidade anteriores.

Todas as mutações acima, exceto troca da própria senha, exigem `Idempotency-Key` para recuperar uma resposta perdida. Reuso com payload diferente retorna conflito. As contas são versionadas e possuem uma geração de autenticação: redefinição/desativação revoga sessões existentes. Senha temporária permite apenas consultar identidade/estado mínimo, trocar senha e sair; demais recursos retornam `PASSWORD_CHANGE_REQUIRED`.

A ficha agora inclui `appointments`. `needs_review` identifica uma nova oportunidade originada de contato com oportunidade encerrada; a configuração do rodízio não libera essas pendências. A atribuição explícita pela gestão resolve a revisão. Históricos antigos permanecem preservados.

- HTTPS, sessão autenticada validada pelo servidor, autorização por recurso e papel.
- Identificadores opacos; datas ISO 8601 com fuso/UTC; valores monetários em centavos com moeda explícita.
- Respostas incluem `request_id`; listas usam paginação por cursor e filtros documentados.
- Frontend recebe `server_time`, vencimento e versão para exibir contador. O servidor continua sendo autoridade.
- Alterações concorrentes usam `version` ou equivalente; versão desatualizada retorna conflito, sem sobrescrever silenciosamente.
- Aceite usa `Idempotency-Key`, vinculado a usuário, operação e conteúdo. Reuso incompatível retorna conflito.
- Leituras e acesso a link de notificação nunca assumem o lead automaticamente. Aceite é comando explícito autenticado.
- Erros estáveis: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `RESERVATION_EXPIRED`, `ALREADY_CLAIMED`, `VERSION_CONFLICT`, `INVALID_INPUT` e `INTEGRATION_UNAVAILABLE`.

## Rotas principais

| Método/rota                              | Finalidade                                                                   |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `GET /me`                                | Perfil, permissões e escopo                                                  |
| `GET /opportunities?view=mine`           | Reservas e oportunidades do usuário                                          |
| `GET /opportunities?view=pool`           | Resumo autorizado do bolsão, incluindo elegibilidade por vencimento          |
| `GET /opportunities/:id`                 | Ficha autorizada e versões atuais                                            |
| `POST /contacts`                         | Cadastro manual com validação de identidade                                  |
| `PATCH /contacts/:id`                    | Complementar contato sem apagar evidências de origem                         |
| `POST /opportunities`                    | Criar oportunidade manual com regra de atribuição explícita                  |
| `PATCH /opportunities/:id`               | Interesse, unidade, etapa e dados comerciais permitidos                      |
| `POST /opportunities/:id/claim`          | Confirmar posse de reserva ou bolsão                                         |
| `POST /opportunities/:id/whatsapp-link`  | Retornar destino somente ao usuário autorizado; não afirma envio de mensagem |
| `POST /opportunities/:id/transfer`       | Transferência administrativa com justificativa                               |
| `GET /opportunities/:id/history`         | Eventos e atividades autorizados                                             |
| `POST /opportunities/:id/activities`     | Registrar tarefa/observação                                                  |
| `POST /opportunities/:id/appointments`   | Agendar consulta e mover a qualificação para follow-up                       |
| `PATCH /appointments/:id`                | Remarcar, concluir ou cancelar mantendo histórico                            |
| `POST /opportunities/:id/contracts`      | Cadastrar contrato e documento privado                                       |
| `POST /contracts/:id/validate-signature` | Validação administrativa autorizada                                          |
| `GET /commissions`                       | Comissões conforme perfil e filtros                                          |
| `GET /distribution/settings`             | Regra atual da fila e participantes                                          |
| `PATCH /distribution/settings`           | Atualização administrativa versionada                                        |
| `GET /reports/overview`                  | Indicadores operacionais e comerciais                                        |
| `GET /reports/meta-ads`                  | Métricas Meta com filtros e atualização                                      |
| `GET /reports/google-ads`                | Métricas Google com filtros e atualização                                    |
| `GET /integrations/status`               | Saúde e última sincronização, sem segredos                                   |
| `POST /notification-subscriptions`       | Registrar dispositivo do próprio usuário                                     |
| `DELETE /notification-subscriptions/:id` | Revogar assinatura autorizada                                                |
| `GET /events`                            | Canal autenticado de atualização, com dados mínimos e escopo                 |
| `POST /tracking/clicks`                  | Registro público limitado/validado da interação do site                      |
| `GET /webhooks/whatsapp`                 | Verificação do endpoint conforme provedor                                    |
| `POST /webhooks/whatsapp`                | Receber eventos assinados e persistir entrada                                |

## Aceite

Corpo proposto: `expected_version` e `mode` (`reservation` ou `pool`). Identidade da atendente vem da sessão, nunca de um identificador confiado no corpo.

Sucesso retorna oportunidade, distribuição `CLAIMED`, responsável, `claimed_at`, nova versão e possibilidade de abrir WhatsApp. O link pode ser solicitado em seguida; falha nessa etapa não desfaz a posse.

Conflito retorna código e orienta recarregar o estado autorizado. Não expor dados de outro responsável além do permitido. Cliente não mostra sucesso antes de confirmação e não enfileira aceites offline.

## Eventos de interface

Eventos propostos: `reservation.created`, `reservation.expired`, `opportunity.claimed`, `opportunity.updated`, `opportunity.transferred`, `integration.status_changed`.

Payload mínimo: `event_id`, tipo, ID do recurso, versão e horário. Na reconexão ou retorno ao primeiro plano, refazer consultas para recuperar a verdade atual; eventos perdidos não podem deixar a tela permanentemente incorreta.

## Rastreamento

Entrada permite páginas e botões registrados, metadados de campanha limitados e horário. Resposta retorna referência opaca sem dados do lead. A referência não permite consultar a ficha e não equivale a prova absoluta de identidade, pois links/mensagens podem ser compartilhados. Conflitos de associação são preservados para revisão.

O script do site deve manter link de contingência para WhatsApp quando o registro do clique falhar. A criação de uma referência não implica criação de contato ou oportunidade.

## Relatórios

Resposta identifica período, fuso, moeda, nível de agregação, última sincronização e definição das métricas. `null`/indisponível não é convertido em zero. Percentuais com base zero são apresentados como não calculáveis. Cobertura de atribuição é retornada junto aos resultados atribuídos.

# Central WhatsApp implementada

Rotas públicas fora do prefixo `/api/v1`: `GET /webhooks/whatsapp` (desafio Meta) e `POST /webhooks/whatsapp` (HMAC-SHA256 obrigatório sobre corpo original, limite de 1 MiB). Desligadas sem configuração. POST confirma apenas após persistir a inbox normalizada; processamento assíncrono e idempotente. `GET /api/v1/whatsapp/status` é exclusivo da gestão e não devolve IDs ou segredos. Consulte [WHATSAPP.md](../WHATSAPP.md).
