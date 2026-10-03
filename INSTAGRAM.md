# Instagram Direct no Artisti CRM

O Instagram é um conector adicional. Ativá-lo não desliga, substitui ou altera o webhook do WhatsApp.

## O que esta entrega implementa

- verificação pública `GET /webhooks/instagram`;
- recebimento assinado `POST /webhooks/instagram`;
- persistência antes da confirmação e processamento com retry;
- identidade por IGSID, sem inventar telefone;
- consulta segura de nome, `@usuario` e URL da foto do remetente, renovada a cada 24 horas;
- preenchimento automático da ficha do lead com nome, perfil, canal e interesse do Direct;
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

No Direct comum, o remetente inicia a conversa. A resposta privada a um comentário é a exceção descrita abaixo. Não é possível escolher um `@usuario` arbitrário para iniciar um Direct.

## Bolsão de comentários

O mesmo webhook aceita `entry[].changes` com o campo `comments`. Assine esse campo na Meta e confirme que o token da conta tem `instagram_business_manage_comments` e `instagram_business_manage_messages`, com o acesso necessário para a conta em produção. Não são necessárias novas variáveis nem outro banco de dados.

- Consultores acessam **Bolsão → Comentários**; a gestão tem **Comentários** no menu.
- Comentários são agrupados por perfil e paginados. Curtidas e comentários de Live não entram neste fluxo.
- **Assumir e conversar** atribui o perfil de forma atômica, cria ou reaproveita o lead e abre o chat. Contatos já atribuídos mantêm o responsável. Contatos encerrados exigem revisão da gestão.
- O comentário aparece identificado no histórico e não abre a janela de mensagens do Direct.
- A primeira abordagem usa `recipient.comment_id`. O servidor consulta a data real do comentário e exige que esteja dentro dos sete dias.
- Após o primeiro envio, o chat aguarda uma resposta. Uma nova mensagem do lead libera o Direct na janela padrão de 24 horas; o CRM não usa a extensão Human Agent neste fluxo.
- Um envio recusado ou sem confirmação fica bloqueado para nova abordagem automática. O consultor deve conferir o Instagram; não há reenvio automático que possa duplicar a abordagem.
- Uma resposta privada confirmada registra também o destinatário retornado pela Meta para associar os próximos Directs ao cadastro.
- Essa confirmação é persistida como um recibo interno antes da finalização. Vínculo do destinatário e status de envio são finalizados na mesma transação. Se falhar, o mesmo pedido, o recebimento do Direct ou o worker (até três pendências a cada 15 segundos) retoma somente o salvamento, sem reenviar para a Meta. Conflitos com outro cadastro não são mesclados automaticamente. A migração `025_private_reply_recovery.sql` e o índice equivalente no MongoDB são aplicados na inicialização.
- Novos comentários disponíveis e comentários de leads já atribuídos usam o sistema de push existente. O conteúdo do comentário não aparece na notificação.
- Apenas texto, IDs e URLs são persistidos. Miniaturas de publicações são opcionais e carregadas diretamente no navegador.
- A exclusão de um lead pela gestão remove seus comentários e registra hashes contra reentrega dos mesmos eventos.

A migração SQL `023_instagram_comments.sql` e os índices equivalentes do MongoDB são aplicados na inicialização. Testes automatizados usam dados sintéticos. Antes da liberação operacional, validar na conta real: comentar com outra conta, assumir, enviar uma resposta privada, responder pelo Instagram e conferir a continuidade no mesmo chat e com o mesmo responsável.

Referência: [Private Replies — Meta](https://developers.facebook.com/docs/instagram-platform/private-replies).

## Eficiência do chat

- Recebimento é por webhook; atualizar a lista no navegador não consulta a Meta.
- O chat mantém uma consulta de lista e uma de histórico por vez, cancela leituras ao sair/trocar de conversa e reduz tentativas após falhas. A atualização periódica pausa com a página oculta.
- A lista usa uma revisão: quando nada mudou, o servidor responde apenas `unchanged` e a revisão. A autenticação e a filtragem por responsável continuam sendo verificadas a cada consulta.
- O histórico fica limitado às 200 mensagens mais recentes. Após ausência longa, a interface recupera a janela atual em vez de percorrer todo o histórico acumulado.
- Fotos de perfil são enriquecidas fora da fila de mensagens, em lotes de até três a cada 15 segundos. Resultados, inclusive sem foto, ficam válidos por 24 horas; falhas têm intervalo mínimo de 15 minutos por perfil. Respostas 429/5xx pausam o enriquecimento opcional por 15 minutos.
- Comentários novos reaproveitam os links da publicação consultada nas últimas 24 horas; falhas de prévia são reaproveitadas por 15 minutos. A data original do comentário é verificada uma vez antes da primeira abordagem e o prazo continua sendo validado a cada envio.
- Imagens, áudio e vídeo continuam priorizando URLs da Meta no navegador. Identificação de mídia compartilhada também tenta a CDN diretamente; o proxy é fallback para incompatibilidades. Transferências pelo proxy são encerradas quando o navegador desconecta. Nenhum arquivo binário é salvo no banco.
- A migração SQL `024_chat_efficiency.sql` e os índices equivalentes do MongoDB são aplicados na inicialização. Não há novos serviços nem variáveis obrigatórias.

## Proteções da integração

- O corpo do POST é validado por `X-Hub-Signature-256` usando o App Secret.
- Eventos repetidos são deduplicados pelo ID da mensagem.
- O endpoint confirma recebimento somente depois da persistência.
- O token nunca é retornado pelas APIs de status.
- Falha ao consultar nome ou foto não bloqueia nem descarta a mensagem; a interface usa fallback.
- O CRM armazena somente a URL temporária fornecida pela Meta, nunca o arquivo da foto.
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
