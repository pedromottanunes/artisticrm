# MongoDB: armazenamento do Artisti CRM

O backend tem implementação nativa com o driver `mongodb`. Não traduz consultas SQL nem mantém uma cópia do banco em memória. O frontend e os endpoints permanecem compatíveis.

## Seleção do banco

- `MONGODB_URI` presente: MongoDB, com nome definido em `MONGODB_DB` (padrão `artisti`). O nome explícito seleciona onde o CRM armazena os registros; `authSource=admin` na URI seleciona onde a credencial autentica, não onde salva os leads.
- `DATABASE_URL` presente sem URI Mongo: PostgreSQL legado.
- Nenhuma conexão definida: apenas desenvolvimento/testes podem usar PGlite local. Produção falha, sem fallback e sem perda silenciosa de persistência.
- As duas conexões presentes: erro explícito de configuração.
- MongoDB exige replica set ou cluster compatível com transações. Atlas atende a esse requisito; uma instância standalone sem replica set não atende.

URI de exemplo, **sem credenciais reais**:

```text
mongodb+srv://USUARIO:SENHA@HOST/artisti?retryWrites=true&w=majority&authSource=admin
```

Usar a URI fornecida pelo Atlas, com usuário e senha preenchidos. Caracteres especiais na credencial precisam de codificação de URL; não codificar a URI inteira. `MONGODB_URI` deve ficar nas variáveis privadas do Render, não no frontend, README ou GitHub. O projeto não lê automaticamente o arquivo de credenciais baixado do Atlas.

## Coleções e garantias

| Coleção | Finalidade / índice principal |
| --- | --- |
| `users` | Contas e hashes de senha; e-mail e posição no rodízio únicos |
| `contacts` | Cadastro; telefone único |
| `opportunities` | Funil, reserva, responsável e prazo; uma oportunidade aberta por contato |
| `distribution_settings` | Prazo, cursor e serialização das operações |
| `appointments` | Avaliações e versões |
| `audit_events` | Histórico de ações |
| `inbound_events` | Deduplicação das entradas |
| `claims` | Recibos idempotentes de aceite |
| `operation_receipts` | Recibos idempotentes das ações administrativas |
| `sessions` | Sessões com token em hash; índice TTL de limpeza |
| `whatsapp_inbox` | Entrada durável, lease, tentativas e conclusão do processamento |

As mutações usam transações com leitura `snapshot` e confirmação `majority`. Um contador de serialização no documento de configuração é atualizado antes das alterações de domínio, ordenando rodízio, aceite, transferências e revogação de acesso. Conflitos transitórios são repetidos pelo driver. Essa opção prioriza consistência para uma equipe pequena; antes de escalar para grandes volumes/múltiplas clínicas, revisar contenção e separar filas explicitamente. Não há envio de mensagens nem efeitos externos dentro das transações. [Transações no driver oficial](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/).

Prazos operacionais são calculados com a hora do banco. O relógio injetável existe apenas para testes. A limpeza TTL das sessões não controla a validade: cada autenticação verifica o prazo e a versão de acesso. O bolsão não usa TTL, pois leads vencidos devem ser preservados.

Cada varredura periódica processa até 100 reservas vencidas, retomando o restante nas próximas varreduras. O aceite sempre verifica o vencimento diretamente. A listagem continua limitada a 500 oportunidades; paginação e métricas agregadas por período não fazem parte desta adaptação.

O usuário Atlas precisa de `readWrite` somente no banco `artisti`, inclusive para criar os índices. A inicialização é repetível e não apaga dados. Não é necessário conceder administrador do Atlas. Há teste automatizado com autenticação MongoDB e exatamente esse papel.

## Testes e migração

`backend/test/mongo.test.ts` usa MongoDB real em replica set temporário via `mongodb-memory-server-core`, sem utilizar `MONGODB_URI` do ambiente. Cobre concorrência, idempotência, deduplicação, permissões, prazo, reinício da conexão, contas, sessões, agenda, bootstrap, webhook e recuperação da inbox. O primeiro teste baixa o binário; a variante `core` evita baixar esse binário na instalação/build do Render. A infraestrutura de teste não é executada no servidor publicado.

O MongoDB inicia vazio. Esta entrega **não importa dados existentes de PostgreSQL ou de outro CRM**, não apaga o banco local anterior e não configura a rede do Atlas. `npm run migrate -w backend`, após o build, inicializa os índices MongoDB quando a URI está definida; isso não é uma conversão SQL→MongoDB. Dados existentes exigem uma importação explícita, validada separadamente.

O Atlas e o Render continuam exigindo configuração de rede/segredos e homologação do deploy. Consulte [DEPLOY.md](DEPLOY.md).
