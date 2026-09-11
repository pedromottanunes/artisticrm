# Celular, instalação e notificações

O CRM tem navegação inferior para gestão e atendimento até 1024 px. Na gestão, deslize essa barra para acessar as demais áreas. No computador, o menu lateral é preservado. Leads e distribuição viram cartões no celular; formulários usam campos maiores e janelas ajustadas ao espaço disponível.

## Instalar no aparelho

1. Abra o endereço HTTPS do CRM e entre na sua conta.
2. Abra **Meu perfil** (atendente) ou **Configurações** (gestão), seção **Este aparelho**. O sino do cabeçalho também abre essa seção.
3. No Android/Chrome, use **Instalar aplicativo** quando disponível ou o menu do navegador → **Adicionar à Tela de Início / Instalar aplicativo**.
4. No iPhone, abra no Safari → Compartilhar → **Adicionar à Tela de Início**. Depois abra pelo novo ícone.
5. Toque em **Ativar notificações**, permita os avisos e use **Testar aviso**. O resultado esperado é uma notificação do sistema, não apenas a confirmação de entrada na fila.

No iPhone/iPad, Web Push exige iOS/iPadOS 16.4 ou posterior e abertura pela Tela de Início. A solicitação de permissão deve partir de uma ação do usuário. Não há publicação na App Store nem exigência de conta Apple Developer para esse mecanismo. [Documentação WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/).

O push depende do sistema operacional, navegador, conexão e permissões. Modo Foco, economia de bateria e bloqueios do aparelho podem alterar a apresentação. Validar em aparelhos reais da equipe; a emulação automatizada não prova a entrega em um iPhone ou Android físico.

## Ativar Web Push no Render

Por padrão, o envio está **desligado**. A instalação e toda a navegação móvel funcionam independentemente dele. Não substituir nem remover as variáveis do WhatsApp/MongoDB.

Em um terminal local, dentro do projeto:

```powershell
npm run push:keys -w backend
```

Copie os valores gerados exclusivamente para **Environment** do Web Service no Render:

```dotenv
PUSH_ENABLED=true
VAPID_PUBLIC_KEY=CHAVE_PUBLICA_GERADA
VAPID_PRIVATE_KEY=CHAVE_PRIVADA_GERADA
VAPID_SUBJECT=mailto:SEU_EMAIL_DE_CONTATO
```

Substitua o e-mail por um endereço real de contato. Guarde o par de chaves em local seguro e mantenha-o estável entre deploys. Não coloque a chave privada no frontend, GitHub, prints ou conversas. O servidor recusa pares incompatíveis quando o push está habilitado. Apenas a chave pública é entregue ao navegador autenticado. [Biblioteca Web Push](https://github.com/web-push-libs/web-push).

Depois do deploy, cada funcionário instala/abre o CRM e ativa os avisos no próprio aparelho. Se precisar trocar o par VAPID, cada aparelho precisará ativar novamente; assinaturas antigas não recebem pelo novo par.

## Comportamento e privacidade

- Reserva nova: avisa a atendente responsável e os dispositivos da gestão.
- Entrada no bolsão: avisa a gestão e atendentes com conta ativa, inclusive as pausadas no rodízio.
- Sem destino/revisão: avisa apenas a gestão. Atribuição/transferência: avisa a nova responsável e a gestão.
- Corpo e título não incluem nome, telefone, mensagem, interesse ou outros dados do contato. Ao tocar, o CRM abre a lista correspondente; continua exigindo login para consultar dados.
- A fila revalida o estado do lead e o acesso antes do envio. Reservas já assumidas, vencidas ou transferidas não geram o aviso antigo que ainda estava pendente no servidor. Um aviso já entregue ao serviço de push não pode ser recolhido pelo CRM; ao abrir, confira o estado atual.
- Sair da conta revoga a assinatura desse aparelho no servidor, mesmo se a limpeza do navegador falhar. Desativação de usuário e mudança/redefinição de senha invalidam as assinaturas antigas. Um aparelho pode ficar associado somente a uma conta por vez.
- A autorização push é renovada por até 30 dias ao usar o CRM autenticado; a sessão de acesso mantém o prazo existente de 8 horas. Receber um aviso não renova a sessão: pode ser necessário entrar novamente.
- Limite de 10 aparelhos por conta e 500 por instalação. Teste de aviso limitado a 3 solicitações por minuto por usuário.

## Operação e limites

Eventos são gravados na mesma transação da distribuição. Assinaturas, eventos e tarefas ficam no banco (`push_records` em MongoDB ou SQL), não no disco do Render. O processador usa leases para múltiplas instâncias e tenta novamente falhas transitórias, até cinco tentativas. Eventos pendentes expiram em uma hora; avisos de teste em cinco minutos. O TTL junto ao serviço push é de no máximo cinco minutos. Reinícios preservam a fila, mas não há garantia de entrega exata: falha entre envio e confirmação pode repetir um aviso; a tag por oportunidade ajuda a substituir duplicatas na bandeja.

No Render Free, o serviço pode suspender após 15 minutos sem tráfego de entrada. Rotinas de expiração e envio não executam enquanto ele dorme; ter o ícone instalado não mantém o servidor acordado. Não prometer notificações imediatas ou prazo operacional garantido nesse plano. Antes de operação real, avaliar hospedagem sem suspensão, monitoramento, backups e procedimentos da equipe. [Limites do Render Free](https://render.com/docs/free).

O aplicativo exige conexão para ler/alterar leads. O service worker guarda apenas logo, ícones e uma página pública de indisponibilidade, **não** respostas da API, fichas, telefones ou páginas autenticadas. Sem internet, a tela avisa que os prazos continuam correndo. Reabrir conectado carrega dados atuais. Depois de atualizar o aplicativo, feche as janelas antigas para o novo service worker assumir.

## Roteiro de homologação

1. Gestão e atendente: instalar, fechar e abrir pelo ícone; navegar por todas as opções inferiores; conferir rotação, teclado, formulário e saída.
2. Ativar avisos e receber **Testar aviso** com o CRM fechado e a tela bloqueada.
3. Criar um lead de teste; confirmar recebimento apenas pela responsável e gestão. Assumir; conferir mudança de estado nos dois perfis.
4. Deixar outra reserva vencer; conferir aviso do bolsão e disputa sem expor telefone antes do aceite.
5. Sair da conta e repetir o teste com outro aparelho ativo: o aparelho desconectado não deve receber novos envios.
6. Testar falha de conexão, reabertura, sessão expirada, permissão bloqueada e navegador sem suporte.

Os testes automatizados usam banco isolado e envio simulado. Não substituem a ativação das chaves no Render e a comprovação de entrega nos celulares.

Para repetir a emulação em WebKit: `npx playwright install webkit` e `npx playwright test --config playwright.mobile.config.ts`. Navegação, formulários, manifesto, cache público e links de abertura são conferidos. No Windows, apenas o teste de recarga com rede desativada é pulado: o WebKit local retorna erro interno também em um worker mínimo que devolve HTML sem usar cache. A recarga offline é testada em Chromium e permanece pendente de homologação no iPhone físico.
