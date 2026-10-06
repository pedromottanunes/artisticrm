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

Estão implementados também o catálogo textual dos anúncios, a sincronização opcional de gastos da Marketing API e o relatório por anúncio, usando credencial separada com `ads_read`. Ainda não estão implementados envio de mídia e OAuth multiempresa. O ambiente atual usa uma conta profissional e uma conta de anúncios configuradas por variáveis privadas.

## Marketing API e métricas

O recurso fica desligado sem `META_MARKETING_ENABLED=true`. Capturar referências de anúncios não depende dessa ativação. Nomes e custos precisam do token autorizado e da conta de anúncios; não basta ter a API do Instagram conectada.

O primeiro evento que cria a oportunidade determina sua origem. Uma referência explícita do webhook registra o `ad_id`; na ausência dela, a entrada do Instagram recebe **Orgânica**, por decisão comercial. Esse rótulo não comprova ausência de influência de publicidade. Indicação e outras origens manuais permanecem preservadas. Uma interação paga posterior não troca a origem inicial nem o consultor.

A ficha mostra nome do anúncio, campanha, conjunto, texto de referência e link da publicação quando disponível, sem miniatura. São metadados consultados na data indicada: o nome do anúncio não é necessariamente o título do post, e o link não comprova a variação exata que cada pessoa viu. As 20 referências recentes e a origem inicial ficam visíveis; referências anteriores permanecem no banco.

Na gestão, o relatório mostra investimento, leads, agendamentos, comparecimentos e vendas registradas por anúncio. O número de leads abre uma lista paginada com acesso às fichas. Custos médios só aparecem quando todos os dias foram consultados e o anúncio foi identificado com destino exclusivo Instagram Direct. Anúncios de outros destinos continuam com investimento separado. Agendamentos e vendas são contagens distintas de oportunidades, não de mensagens; resultados são o estado atual dos leads adquiridos no período. Valor de venda desconhecido não é zero; valores registrados não são pagamentos recebidos. O custo médio do anúncio não é um custo individual comprovado do lead.

As telas leem o banco, não a Meta. Uma falha de marketing não interrompe webhooks, distribuição ou chat. Somente a gestão pode ler investimento/desempenho e solicitar sincronização; consultores recebem os nomes apenas nas fichas autorizadas.

### Limites e retomada

- Um ciclo por conta, protegido por posse temporária persistida no banco; no máximo cinco anúncios e 20 chamadas por ciclo, com orçamento compartilhado de 120 chamadas por hora.
- Conta, nomes e criativos reaproveitados por 24 horas; anúncios sem atividade conhecida há mais de 32 dias deixam de ser renovados até nova referência/consulta de histórico.
- Custos: hoje e ontem a cada hora; sete dias diariamente; 31 dias semanalmente. Histórico dividido em janelas de até sete dias, com progresso persistido. A primeira carga pode levar vários ciclos.
- Botão manual apenas agenda o período selecionado, de até 31 dias; intervalo mínimo de cinco minutos. Não ignora bloqueios da Meta.
- Leituras limitadas a 30 segundos por chamada, 90 segundos por ciclo, 2 MiB por resposta e 8 MiB por ciclo. Nenhuma resposta parcial substitui o último intervalo completo.
- Respostas de limitação e indicadores de uso alto suspendem novas consultas; token inválido suspende até reautorização/configuração corrigida. Erros transitórios têm espera crescente, preservada após reiniciar o Render.
- Relatório com até 31 dias e 50 anúncios por página; limite de 1.000 anúncios com aviso de resultado incompleto. Lista de leads por anúncio usa cursor de 50 registros. Transações analíticas não utilizam a trava da distribuição.
- Apenas IDs, textos, links e números no MongoDB. Sem imagens, vídeos, previews ou cópias de conversas na integração de marketing. Nenhuma criação/edição de anúncio e nenhum envio de dados de pacientes à Marketing API.

### Ativação após publicar o código

1. Confirme qual é a conta de anúncios da clínica e quem administra esse ativo no negócio da Meta. O ID de anúncios é diferente do ID do Instagram e do aplicativo.
2. No aplicativo/negócio autorizado, confira o acesso à Marketing API e à conta de anúncios. Use um token apropriado para Marketing com `ads_read` e permissão sobre esse ativo. O nível de acesso/análise exigido depende da configuração do aplicativo e de quem possui o ativo; confirme no painel antes de ativar. Não substitua o token do Instagram.
3. Em **Render → serviço do CRM → Environment**, prepare estas variáveis privadas. Os valores entre `<...>` são campos a preencher, não credenciais prontas:

   ```text
   META_MARKETING_ENABLED=false
   META_MARKETING_ACCESS_TOKEN=<token autorizado com ads_read>
   META_AD_ACCOUNT_ID=act_<ID numérico da conta de anúncios>
   ```

4. Mantenha a `META_GRAPH_VERSION` já validada na integração. Não altere a versão compartilhada só para ativar marketing. `META_AD_TIMEZONE` é opcional: se omitida, o CRM lê o fuso da conta; se declarada, precisa coincidir com ele. Não use variáveis `VITE_` para tokens.
5. Depois de confirmar acesso, altere apenas `META_MARKETING_ENABLED` para `true`, salve e aguarde o deploy. Nenhuma alteração no webhook, no login ou nas variáveis `INSTAGRAM_*` é necessária para esse recurso.
6. Entre como master em **Relatórios**. Aguarde a sincronização e confira um anúncio conhecido. Em caso de falta de autorização, corrija a permissão/token no backend e solicite a sincronização novamente, respeitando o intervalo do botão. Não insista em tentativas repetidas.
7. Homologue a associação com uma mensagem de teste originada de um anúncio conhecido: confira o ID/nome, responsável, ficha e lista do relatório. Compare investimento com a mesma conta, datas, moeda e fuso no Gerenciador da Meta. Testes automatizados não substituem essa conferência na conta real.

Para interromper a integração opcional, use `META_MARKETING_ENABLED=false`. Os dados já salvos permanecem; o atendimento do Instagram não depende desse recurso. O plano Free do Render pode suspender também essas rotinas enquanto o serviço dorme.

Os registros antigos podem ter referências e nomes recuperados, mas não serão convertidos em aquisições pagas pela primeira referência encontrada: isso poderia atribuir uma venda ao anúncio errado. A medição de origem inicial vale para oportunidades criadas após a implantação; legados sem essa projeção ficam no grupo Orgânica do relatório. Não use o CPL histórico anterior à implantação como medida completa.

Referências: [Marketing API oficial e permissões](https://www.postman.com/meta/facebook-marketing-api/collection/0zr4mes/facebook-marketing-api-mapi), [campos do anúncio no SDK oficial](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/ad.py), [campos do criativo no SDK oficial](https://github.com/facebook/facebook-python-business-sdk/blob/main/facebook_business/adobjects/adcreative.py).

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
