# Facebook Messenger no Artisti CRM

O conector recebe mensagens da Página do Facebook, cria ou atualiza o lead, aplica o mesmo rodízio do CRM e disponibiliza a conversa na caixa multicanal. A resposta é enviada pela Página apenas pelo consultor responsável e dentro da janela de 24 horas aberta pela última mensagem do cliente.

## Variáveis no Render

Nunca salve os valores secretos no repositório.

```text
MESSENGER_ENABLED=true
MESSENGER_APP_SECRET=<chave secreta do app ARTISTI CRM>
MESSENGER_VERIFY_TOKEN=<segredo aleatório com pelo menos 32 caracteres>
MESSENGER_PAGE_ID=366748579845081
MESSENGER_PAGE_ACCESS_TOKEN=<token da Página Artisti Transplante Capilar>
META_GRAPH_VERSION=v26.0
```

O `MESSENGER_APP_SECRET` é a mesma chave secreta do aplicativo Meta, mas deve existir com esse nome no Render. O `MESSENGER_VERIFY_TOKEN` é criado por nós e deve ser exatamente igual no Render e na tela de webhook da Meta.

## Ativação na Meta

1. Publique esta versão no Render e confirme que o serviço iniciou sem erro.
2. Ative as variáveis acima e faça novo deploy/restart.
3. Em **Messenger from Meta → Configurações da API do Messenger → Configure webhooks**, informe:
   - URL de callback: `https://artisticrm.onrender.com/webhooks/messenger`
   - Token de verificação: o valor de `MESSENGER_VERIFY_TOKEN`
4. Clique em **Verificar e salvar**.
5. Assine, no mínimo, `messages` e `messaging_postbacks`. Se a tela oferecer `messaging_referrals`, assine também para preservar referências de anúncios e links.
6. Na Página **Artisti Transplante Capilar**, clique em **Adicionar assinaturas** e confirme os mesmos campos para a Página.
7. Para mensagens de pessoas que não possuem função no app, solicite acesso avançado de `pages_messaging` na análise do aplicativo.

## Teste final

1. Envie uma mensagem real para a Página por uma conta pessoal autorizada para teste.
2. Em **Central**, confirme que o Messenger mostra horário de recebimento e processamento.
3. Confirme que o lead entrou no rodízio com origem **Facebook Messenger**.
4. O consultor reservado assume o lead e abre **Conversas**.
5. Envie uma resposta curta pelo CRM e confirme o recebimento no Messenger.

O diagnóstico autenticado da gestão está em `GET /api/v1/messenger/status`. Ele nunca retorna o token ou a chave secreta.

## Proteções de estabilidade

- O webhook valida a assinatura e grava os eventos antes de confirmar o recebimento. O processamento usa fila persistente, deduplicação e lotes limitados, sem consultar a Meta dentro da transação do rodízio.
- A listagem filtra o responsável antes do limite de 100 conversas e busca contatos e indicadores de leitura em lote, usando os índices existentes.
- Antes de reservar um envio, a transação revalida sessão, responsável e janela de 24 horas. Repetir a mesma chave retorna o resultado existente, sem reenviar; envios de resultado incerto não são repetidos automaticamente.
- As consultas de nome/foto rodam separadas da entrada de leads, em lotes de até três. Falhas transitórias ou limites da Meta pausam a fila de perfis por pelo menos 15 minutos, respeitando um `Retry-After` maior. A pausa fica no banco e sobrevive ao reinício.
- A migração SQL `039_messenger_resilience.sql` adiciona apenas o campo de pausa em `channel_accounts`. No MongoDB, o campo é gravado quando necessário.

Os testes automatizados usam dados sintéticos e uma API simulada. Eles não substituem a validação final do webhook, permissões e entrega no ambiente da Meta.
