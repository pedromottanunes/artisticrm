# GitHub → Render: homologação

## Arquitetura inicial

```text
Repositório GitHub
  ├─ frontend/ ── build React/Vite ─┐
  └─ backend/ ── build Fastify ────┴─ Web Service Node / HTTPS
                                      └─ Render PostgreSQL privado
```

O código continua separado nas duas pastas. Um único serviço serve a interface e `/api`, simplificando cookies de sessão, origem e configuração. Os ativos de logo e fonte são locais ao build, sem dependência do site da clínica no carregamento.

Reservas, cursor e inbox da central WhatsApp vivem no PostgreSQL, não no disco temporário do serviço. A reconciliação e o processador da inbox executam dentro da API, com prazo persistido, leases e repetição idempotente. Não há pg-boss nem serviço worker separado nesta entrega. Push e sincronização de anúncios ainda precisam de implementação.

## Antes de subir ao GitHub

1. Criar um repositório, preferencialmente privado, sob a conta/organização autorizada.
2. Versionar código, especificações, migrations, lockfile e `render.yaml`.
3. Não incluir `.env`, banco `.data`, tokens, documentos ou exportações de pacientes.
4. Executar os comandos de validação do README.
5. Configurar proteção da branch principal e exigir a CI antes de integrar alterações. A criação/configuração do repositório ainda não foi feita.

O workflow `.github/workflows/ci.yml` instala dependências, verifica tipos, executa testes com PGlite e PostgreSQL 18, compila e testa a interface em Chromium. As credenciais do PostgreSQL nesse workflow são apenas para o banco efêmero de testes, não são segredos de operação.

## Criar a homologação no Render

1. Autorizar a conta Render a acessar o repositório correto.
2. Criar um Blueprint a partir do `render.yaml`, mantendo o diretório raiz do repositório.
3. Conferir a região e os planos de Web Service/PostgreSQL. **São recursos pagos**, sem autorização de contratação nesta entrega; os preços e disponibilidade precisam ser conferidos antes da confirmação.
4. Definir e-mail e senha de bootstrap na interface do Render. Usar senha forte, exclusiva, com pelo menos 16 caracteres; nunca colocá-la no código.
5. Aplicar o Blueprint. `autoDeployTrigger: off` mantém deploys posteriores manuais até o fluxo de publicação ser aprovado.
6. Verificar o health check, entrar com a conta criada e validar os fluxos com dados de teste.

Configuração usada:

| Campo | Valor |
| --- | --- |
| Build | `npm ci --include=dev && npm run build` |
| Pre-deploy | `npm run migrate -w backend` |
| Start | `npm run start -w backend` |
| Health check | `/api/health` — verifica acesso ao banco |
| Node | 22.18.0 |
| Porta/host | `PORT` fornecida pelo Render, host `0.0.0.0` |
| Instâncias iniciais | 1; rate limiting em memória exige revisão antes de escalar |
| Banco | PostgreSQL 18, rede privada, sem IPs externos autorizados |

O processo também confere migrations ao iniciar; são versionadas, transacionais e serializadas com um advisory lock no PostgreSQL. Fazer backup antes de futuras migrations destrutivas. Não há rollback automático de schema implementado.

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `NODE_ENV=production` | Desativa seed demo, exige PostgreSQL, ativa cookie Secure e serve frontend compilado |
| `DATABASE_URL` | Ligação privada ao PostgreSQL, preenchida por `fromDatabase` |
| `BOOTSTRAP_ADMIN_EMAIL` | E-mail da primeira conta de gestão |
| `BOOTSTRAP_ADMIN_PASSWORD` | Senha da primeira conta, 16–128 caracteres |
| `RENDER_EXTERNAL_URL` | Origem HTTPS padrão fornecida pelo Render |
| `APP_ORIGIN` | Opcional: origem HTTPS canônica ao usar domínio próprio, sem caminho |
| `PORT` | Porta fornecida pelo Render |

O bootstrap só cria a primeira conta quando não há usuários. Depois do primeiro acesso confirmado, remover `BOOTSTRAP_ADMIN_PASSWORD` do ambiente; o servidor não precisa dela para reiniciar com banco inicializado. Alterar essa variável não muda senhas existentes. A conta autenticada pode trocar sua senha em Configurações; recuperação autônoma por e-mail ainda não está implementada.

Não reutilizar a base local de demonstração no Render: o servidor publicado se recusa a iniciar se detectar contas `@demo.artisti.local`. A opção `ARTISTI_EPHEMERAL_DB` serve só aos testes e nunca substitui `DATABASE_URL` em produção.

As credenciais da central são opcionais e configuradas conforme [WHATSAPP.md](WHATSAPP.md). O webhook fica desligado até a ativação explícita. Credenciais de anúncios Meta/Google e exportação automática de conversões continuam pendentes.

## Criar atendentes de homologação

Preferir **Configurações → Equipe e acessos → Nova atendente**. Informar nome, e-mail, posição livre e senha temporária de pelo menos 16 caracteres. Entregar a senha por canal seguro: a atendente deverá trocá-la antes de consultar os leads.

Na mesma área, a gestão pode redefinir a senha temporária (revogando sessões), renomear a atendente e desativar/reativar sua conta. A desativação exige outra atendente ativa quando houver leads abertos sob responsabilidade ou reserva; a transferência e a revogação são atômicas. Dados históricos não são apagados.

Alternativa técnica: há um comando administrativo explícito, executado somente por quem tem acesso ao ambiente autorizado:

1. No serviço de homologação, configurar temporariamente `CREATE_USER_NAME`, `CREATE_USER_EMAIL`, `CREATE_USER_PASSWORD` (16+ caracteres) e `CREATE_USER_POSITION` (1–99, única).
2. No shell do serviço, executar `npm run user:create -w backend`.
3. O comando cria uma atendente habilitada na posição indicada. E-mail/posição repetidos falham, sem sobrescrever contas.
4. Remover as quatro variáveis após o uso e entregar a senha por canal seguro. Não escrever senhas em comandos que fiquem no histórico.
5. Repetir com identidades reais das atendentes de teste; nomes e ordem da proposta precisam ser confirmados.
6. Se existirem leads pendentes de antes da criação da equipe, salvar a configuração da fila pela gestão para distribuí-los.

Convites por link, recuperação autônoma por e-mail, MFA e administração de outras contas de gestão continuam pendentes. As ações disponíveis não substituem a homologação de segurança antes da operação real.

## Critérios antes de operar com pacientes

- Homologar os testes em PostgreSQL externo e revisar resultados da CI.
- Validar comportamento em aparelhos reais e acesso HTTPS móvel.
- Implementar entrada oficial WhatsApp com assinatura, destinatário permitido, inbox durável e deduplicação por conta/número/evento.
- Implementar push e monitorar falhas; não depender da consulta com navegador aberto.
- Confirmar regras de reentrada, horários, transferências e comissão com Cadu.
- Implementar paginação e consultas agregadas adequadas ao volume (hoje: até 500 oportunidades por resposta).
- Completar gestão de identidades, revogação e recuperação de acesso; avaliar MFA para gestão.
- Formalizar acesso por unidade/papel, retenção, descarte, auditoria de edição detalhada e tratamento de dados sensíveis.
- Configurar monitoramento operacional, alertas, rate limiting compatível com a topologia e uma política de backup/restauração testada.
- Usar armazenamento privado externo quando houver documentos; nunca gravá-los no filesystem efêmero do Web Service.
- Planejar migração do número central, importação, treinamento e retorno operacional. Apenas um distribuidor deve comandar a operação real.

## Referências oficiais

Configuração baseada na [referência de Blueprints do Render](https://render.com/docs/blueprint-spec) e nas [variáveis de ambiente disponibilizadas pelo Render](https://render.com/docs/environment-variables). Validar o Blueprint na conta antes de aplicar: nenhum deploy externo foi realizado ou confirmado por esta entrega.

O banco embarcado segue a [API do PGlite](https://pglite.dev/docs/api), exclusivamente para desenvolvimento/testes; o ambiente publicado usa o driver `pg` e PostgreSQL separado.
# Ativação opcional da central

A integração WhatsApp fica desligada no blueprint. Depois do deploy, siga [WHATSAPP.md](WHATSAPP.md) para configurar os segredos e IDs no ambiente, verificar o webhook HTTPS e assinar a WABA. Não coloque número ou credenciais no repositório. A tela Configurações mostra o estado da fila sem expor segredos.
