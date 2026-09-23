# Instagram Direct no Artisti CRM

O Instagram é um conector adicional. Ativá-lo não desliga, substitui ou altera o webhook do WhatsApp.

## O que esta entrega implementa

- verificação pública `GET /webhooks/instagram`;
- recebimento assinado `POST /webhooks/instagram`;
- persistência antes da confirmação e processamento com retry;
- identidade por IGSID, sem inventar telefone;
- consulta segura de nome, `@usuario` e foto do remetente, renovada a cada 24 horas;
- criação/reentrada de oportunidade usando o mesmo rodízio ponderado;
- histórico de Directs e resposta de texto pela Send API;
- acesso da atendente somente depois do aceite;
- acompanhamento gerencial e status técnico sem expor segredos;
- evidência de anúncio preservada apenas quando o webhook fornece um ID explícito.

Estão implementados também a sincronização opcional de gastos da Marketing API e o relatório por campanha, usando credencial separada com `ads_read`. Ainda não estão implementados envio de mídia e OAuth multiempresa. O ambiente atual usa uma conta profissional e uma conta de anúncios configuradas por variáveis privadas.

## Marketing API e métricas

Configure `META_MARKETING_ENABLED=true`, `META_MARKETING_ACCESS_TOKEN`, `META_AD_ACCOUNT_ID=act_...`, `META_AD_TIMEZONE=America/Sao_Paulo` e `META_GRAPH_VERSION`. O servidor sincroniza insights diários no nível de anúncio a cada 30 minutos e a gestão também pode solicitar atualização manual. Uma falha nessa sincronização não interrompe webhooks, distribuição ou chat.

O painel cruza o `ad_id` recebido como evidência no Direct com os anúncios sincronizados. Exibe separadamente leads associados, evidências ainda não encontradas nos insights e entradas orgânicas/sem atribuição. O CPL só é calculado com leads efetivamente associados; o CRM não escolhe campanha por horário ou aproximação.

## Variáveis

```text
INSTAGRAM_ENABLED=true
META_GRAPH_VERSION=v26.0
INSTAGRAM_APP_SECRET=<app secret do app Instagram>
INSTAGRAM_VERIFY_TOKEN=<segredo aleatório com 32+ caracteres>
INSTAGRAM_ACCOUNT_ID=<ID numérico da conta profissional>
INSTAGRAM_ACCESS_TOKEN=<token gerado para a conta profissional>
INSTAGRAM_USERNAME=<opcional, sem @>
```

O `INSTAGRAM_VERIFY_TOKEN` é criado por nós e informado igualmente no CRM e no painel da Meta. Ele não é o access token.

Não use o token que apareceu em arquivos, mensagens ou capturas de tela. Revogue-o e gere outro antes da homologação. Configure segredos na interface do Render; não grave valores reais em `.env`, `TOKENS.txt`, Git ou logs.

## Configuração do callback na Meta

1. Publique uma versão HTTPS do CRM em serviço sempre ativo.
2. Configure a URL: `https://SEU-DOMINIO/webhooks/instagram`.
3. Informe o mesmo valor de `INSTAGRAM_VERIFY_TOKEN`.
4. Assine o campo de mensagens exigido pela versão atual da API.
5. Ative a assinatura do webhook para a conta profissional, incluindo `messages`,
   `messaging_referral` e `messaging_postbacks`.

Uma referência de anúncio recebida antes da mensagem fica pendente por até 24 horas. Ela
só é vinculada quando a pessoa envia uma mensagem ou aciona um postback; apenas abrir o
anúncio não cria lead nem movimenta o rodízio. 6. Envie um Direct a partir de outra conta. 7. Em **Configurações → Instagram Direct**, confirme a última mensagem recebida/processada. 8. Aceite o lead com uma atendente e responda em **Conversas**.

O remetente deve iniciar a conversa. A API responde usando o IGSID recebido no webhook; não é possível escolher um `@usuario` arbitrário no campo “Até”.

## URLs e segurança

- O corpo do POST é validado por `X-Hub-Signature-256` usando o App Secret.
- Eventos repetidos são deduplicados pelo ID da mensagem.
- O endpoint confirma recebimento somente depois da persistência.
- O token nunca é retornado pelas APIs de status.
- Falha ao consultar nome ou foto não bloqueia nem descarta a mensagem; a interface usa fallback.
- A mensagem de saída exige sessão, posse `CLAIMED` e `Idempotency-Key`.

## Teste local do código

Os testes usam IDs, segredos e mensagens sintéticos; não chamam a Meta.

```bash
npx tsx --test backend/test/instagram.test.ts
npm test
npm run build
```

Para um teste real, o callback precisa ser HTTPS e acessível pela Meta. Não exponha o servidor local diretamente sem autenticação operacional e controle do túnel.

## Produção

Em desenvolvimento, somente contas com função/teste autorizada no app são usadas. Para conectar a conta real de um cliente, será necessário concluir verificação empresarial, política de privacidade, exclusão de dados e App Review com acesso avançado para as permissões de mensagens do Instagram.

Referência oficial da Send API: https://www.postman.com/meta/instagram/folder/uxudqu0/send-api
