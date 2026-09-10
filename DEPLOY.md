# GitHub → Render + MongoDB Atlas

## Configuração para o ambiente de teste

Um **Web Service Node Free** serve o frontend compilado e a API no mesmo domínio. O banco é o **MongoDB Atlas já criado**, fora do Render. Não criar Static Site, Background Worker nem PostgreSQL para esta configuração.

| Campo no Render | Valor |
| --- | --- |
| Repositório | `pedromottanunes/artisticrm` |
| Branch | `main` |
| Language | `Node` |
| Root Directory | Deixar vazio |
| Build Command | `npm ci --include=dev && npm run build` |
| Start Command | `npm run start -w backend` |
| Instance Type | `Free` |
| Health Check Path | `/api/health` |

Alternativa: o [render.yaml](render.yaml) cria esse Web Service via Blueprint. A URI do Atlas e o acesso inicial são preenchidos no painel, nunca no GitHub. O Blueprint não cria nem apaga o cluster Atlas. Se já estiver usando criação manual, não é preciso criar outro serviço via Blueprint.

## Variáveis no Render

Em **Environment → Add from .env**, inserir o bloco abaixo, substituindo os três valores indicados. Não publicar credenciais no repositório.

```dotenv
NODE_ENV=production
NODE_VERSION=22.18.0
MONGODB_URI=COLE_AQUI_SUA_CONNECTION_STRING_COMPLETA
MONGODB_DB=artisti
BOOTSTRAP_ADMIN_EMAIL=SEU_EMAIL_DE_LOGIN
BOOTSTRAP_ADMIN_PASSWORD=SUA_SENHA_DE_LOGIN
WHATSAPP_ENABLED=false
```

- Remover `DATABASE_URL` se tiver sido cadastrada: o processo recusa dois bancos configurados simultaneamente.
- A senha de login aceita 6 a 128 caracteres. Ela é diferente da senha do usuário MongoDB, embutida na URI.
- `MONGODB_DB=artisti` corresponde à permissão `readWrite@artisti` configurada no Atlas.
- `PORT` e `RENDER_EXTERNAL_URL` são fornecidas pelo Render. Não é necessário cadastrá-las manualmente.
- `APP_ORIGIN` só é necessária para definir um domínio HTTPS próprio como origem canônica.

## Liberar o acesso ao Atlas

No Web Service, consulte **Connect → Outbound** e copie os IPs/faixas de saída apresentados. No Atlas, em **Database & Network Access → IP Access List**, adicione esses IPs/faixas. Autorizar apenas o IP do seu computador não libera o Render. Não é necessário abrir a rede inteira. [Guia oficial Render/Atlas](https://render.com/docs/connect-to-mongodb-atlas).

Se ainda não houver serviço salvo para consultar os IPs, um primeiro deploy pode falhar na conexão. Depois de liberar as faixas, repetir o deploy. Não alterar permissões para administrador: `readWrite` no banco `artisti` é suficiente.

## O que acontece no primeiro início

1. O servidor conecta ao Atlas e verifica suporte a transações.
2. Cria as coleções/índices necessários e a configuração inicial de dez minutos, sem apagar registros existentes.
3. Se o banco não tem usuários, cria somente a conta de gestão usando o e-mail/senha de bootstrap.
4. Passa a servir a interface e a API. `/api/health` verifica acesso ao banco.

Não são criados pacientes fictícios, números de central ou atendentes automaticamente no MongoDB. Após entrar, cadastre as atendentes em **Configurações → Equipe e acessos**. Defina nome, e-mail, posição no rodízio e senha temporária. O primeiro acesso exige troca da senha. Não é necessário cadastrar o telefone da atendente.

Após confirmar o primeiro login, pode remover `BOOTSTRAP_ADMIN_PASSWORD`. Alterar essa variável **não redefine uma senha existente**; a troca ocorre na aplicação. Se já houver pendências, salvar a configuração da fila após habilitar a equipe para distribuí-las.

## Persistência e limitações

Leads, usuários, sessões, reservas, cursor do rodízio, auditoria e inbox WhatsApp ficam no Atlas. Reiniciar/republicar o Web Service não apaga esses registros. A integração WhatsApp continua desligada até configurar os IDs e segredos descritos em [WHATSAPP.md](WHATSAPP.md).

O Render Free dorme após 15 minutos sem tráfego e pode demorar para acordar. Enquanto dorme, os processadores não executam. O prazo original permanece no banco, e o bolsão é reconciliado ao retomar; não existe garantia de execução pontual no décimo minuto durante suspensão. Essa limitação também afeta a recepção imediata de webhooks. [Limites oficiais do Free](https://render.com/docs/free).

Use dados de teste. Antes de operação real: homologar Meta e celulares, implementar push, definir backup/restauração e monitoramento, revisar capacidade/planos, segurança e regras comerciais. A migração de dados de outro CRM/PostgreSQL não é automática. [Detalhes técnicos MongoDB](MONGODB.md).

## Validação local e CI

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run test:release
npx playwright install chromium
npm run test:e2e
```

Os testes MongoDB usam um replica set real, temporário e isolado; baixam o binário na primeira execução. Nenhum teste usa a URI do seu Atlas. Os testes SQL foram preservados para evitar regressões na demonstração local. A CI também valida PostgreSQL externo como modo legado.

Os arquivos `.env`, dados locais, tokens e credenciais permanecem fora do Git. Backups e futuras mudanças destrutivas de estrutura exigem planejamento próprio; não há rollback automático de dados.
