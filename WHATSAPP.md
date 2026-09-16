# Central WhatsApp — ativação posterior

A integração foi preparada para WhatsApp Cloud API, sem número, conta Meta ou credenciais reais. Nenhuma configuração externa foi alterada. O recebimento permanece desligado por padrão.

## Configuração no Render

Após publicar o backend com MongoDB Atlas e HTTPS, defina no ambiente do serviço (nunca no Git):

| Variável | Valor a fornecer depois |
| --- | --- |
| `WHATSAPP_ENABLED` | `true` somente ao ativar |
| `WHATSAPP_APP_SECRET` | Segredo do aplicativo Meta que assinará os webhooks |
| `WHATSAPP_VERIFY_TOKEN` | Segredo aleatório próprio, com pelo menos 32 caracteres, usado na verificação do webhook |
| `WHATSAPP_WABA_ID` | ID da conta WhatsApp Business autorizada |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do recurso de telefone na Cloud API, não o número com DDD |

Sem ativação, GET/POST do webhook retornam 503. Ativar com configuração incompleta impede a inicialização. Para trocar a central, confira pendências da central anterior antes de alterar os IDs: o processador só consome eventos do ID configurado.

## Configuração posterior na Meta

1. Confirme a titularidade/autorização, registro Cloud API do número e integrações existentes. Não desconecte serviços ou exclua contas WhatsApp sem planejar a mudança.
2. Configure callback `https://SEU-DOMINIO/webhooks/whatsapp` e o mesmo verify token do servidor. A aplicação atende ao desafio GET com `hub.mode`, `hub.verify_token` e `hub.challenge`.
3. Habilite o campo `messages` do objeto WhatsApp Business Account no aplicativo.
4. Com um access token válido e acesso à WABA, configure a assinatura do aplicativo na WABA (`/{WABA-ID}/subscribed_apps`) conforme a documentação Meta. Confira assinaturas existentes antes de alterar. A verificação do callback sozinha não estabelece essa assinatura.
5. Mantenha o access token em canal seguro. Ele é necessário para administrar recursos na Meta, mas não para receber e validar o webhook neste backend. App Secret, verify token e access token são segredos diferentes.
6. Envie uma mensagem de um WhatsApp de teste à central. Verifique **Configurações → WhatsApp central** e o lead atribuído. A central não responderá.

## Fluxo e garantias

- POST exige HMAC-SHA256 sobre os bytes originais com `X-Hub-Signature-256`. A rota não depende de sessão de navegador. As APIs do CRM continuam protegidas por sessão e controles de origem.
- Aceita somente a WABA e o Phone Number ID configurados. Eventos de outros recursos e campos, incluindo histórico/echoes, são ignorados. Status de entrega sem mensagem não cria lead.
- O evento é confirmado com HTTP 200 somente depois de persistir o lote normalizado. Falha no banco retorna erro para permitir reenvio pela Meta.
- Fila durável no MongoDB (também suportada no PostgreSQL legado), processada no backend a cada segundo, com exclusão mútua por evento, lease recuperável após dois minutos e novas tentativas com espera progressiva até cinco minutos. O processo precisa de um serviço continuamente disponível.
- Deduplicação permanente pelo ID da mensagem. Repetição após crash não recria o lead nem avança novamente o rodízio. Novas mensagens do mesmo contato preservam a oportunidade aberta.
- O prazo da reserva começa quando o backend efetivamente distribui o lead, não no clique do site. Sem destinatária habilitada, fica pendente até habilitar o rodízio.
- Nome e telefone vêm do webhook. Texto, mídia e histórico de chat não são armazenados; não há downloads de anexos ou respostas automáticas. Mensagens sem telefone válido são rejeitadas para diagnóstico, não convertidas em contatos fictícios.
- Origem padrão: “Não identificada”. Quando a primeira mensagem traz uma referência de anúncio, são preservados o ID e a URL da origem, `ctwa_clid`, título, texto, formato e URLs da mídia publicitária fornecidos no próprio webhook. Cada nova referência fica no histórico da oportunidade e não apaga as anteriores.
- Esta etapa não consulta a Marketing API nem qualquer outro endpoint da Meta. Nomes de campanha, conjunto e anúncio só poderão ser enriquecidos posteriormente; até lá, o CRM exibe exclusivamente os dados comprovadamente recebidos no webhook assinado.
- Texto pré-preenchido do site não prova Google Ads; GTM/atribuição do site continuam sendo uma integração separada.
- `GET /api/v1/whatsapp/status`, exclusivo da gestão, exibe configuração, pendências, tentativas e últimas datas sem revelar credenciais. “Configurado” não significa verificação de conectividade externa.
- As linhas normalizadas da fila e IDs de deduplicação são mantidos. Planejar retenção/eliminação de dados e backups antes da operação com pacientes; não remover IDs de eventos indiscriminadamente, pois reenvios poderiam criar novas oportunidades.

## Testes antes da operação real

Execute `npm test`, `npm run typecheck`, `npm run build`, `npm run test:release` e `npm run test:e2e`. A CI também roda testes com PostgreSQL externo quando configurada. Homologar com Meta e aparelhos reais antes de operar: mensagem recebida, perfil sem nome, áudio como primeira entrada, reenvio, ausência de atendentes habilitadas, reserva, bolsão e disputa.

Esta entrega não inclui push/PWA nem conexão via WhatsApp Web/GPT Maker/coexistência. A área das atendentes atualiza enquanto aberta; assume o lead e abre o WhatsApp da conta disponível no aparelho, em conversa distinta daquela com a central.

Referências: [Cloud API e assinatura WABA](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [payloads oficiais](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference), [validação de assinatura documentada pela Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/).
