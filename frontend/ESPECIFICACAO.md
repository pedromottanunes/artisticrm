# Especificação do frontend

Status: especificação-alvo, com primeira interface já implementada em React/TypeScript. O [README](../README.md) delimita entregas e pendências. Uma aplicação com áreas distintas por perfil, compartilhando componentes e API; o deploy entrega o frontend compilado pelo backend no mesmo domínio.

## Identidade visual confirmada

Referência: https://artistitransplantecapilar.com.br/ (domínio .com.br indicado pelo cliente).

| Elemento | Valor observado |
| --- | --- |
| Azul-marinho | `#07192D` |
| Dourado principal | `#EDB25A` |
| Branco | `#FFFFFF` |
| Fonte da interface do site | Montserrat |
| Botões de destaque | Dourado, texto escuro, arredondamento de 12px em componentes inspecionados |
| Atmosfera | Fundos escuros, contraste forte e detalhes dourados |

Fontes: `https://artistitransplantecapilar.com.br/wp-content/uploads/elementor/css/post-7.css` e `post-2.css`.

Logo branca original identificada: https://artistitransplantecapilar.com.br/wp-content/smush-webp/2024/05/artisti-transplante-capilar-logo-white.png.webp

Usar o arquivo original com proporção preservada. A tipografia do logotipo faz parte do desenho e não deve ser reconstruída usando Montserrat. Na implementação, armazenar cópia autorizada no projeto em vez de depender de carregamento remoto do site. Ícone reduzido para instalação deve ser preparado a partir de material de marca adequado, não por distorção do logotipo horizontal.

Aplicar azul-marinho na estrutura, superfícies escuras distinguíveis, texto claro e dourado para ação primária/seleção. Cores de erro, sucesso e urgência são extensões funcionais a especificar com contraste testado. Dourado sobre branco não deve ser usado indiscriminadamente em texto pequeno. Tamanhos e pesos do site serão adaptados para leitura de dados e formulários.

## Área de gestão

Navegação proposta: Visão geral, Leads, Funil, Agenda, Distribuição e bolsão, Meta Ads, Google Ads, Contratos e comissões, Equipe e configurações.

| Tela | Conteúdo e ações |
| --- | --- |
| Visão geral | Entradas, aceites, tempo de aceite, expirações, bolsão, agendamentos e vendas |
| Leads | Pesquisa por nome/telefone, filtros por responsável, unidade, origem, etapa e período; cadastro manual |
| Ficha | Contato editável, interesse, etapa, próxima ação, avaliações, origem, contrato e histórico |
| Funil | Colunas comerciais; mudança de etapa validada no servidor; alternativa acessível ao arrastar |
| Agenda | Avaliações com data/hora, unidade e estado; remarcação e cancelamento |
| Distribuição | Ordem da fila, habilitação de participantes, prazo e pendências; mudanças auditadas |
| Meta Ads | Investimento, impressões, cliques relevantes, CTR/CPC, conversões da plataforma e resultados CRM |
| Google Ads | Mesma organização de indicadores com nomenclatura própria; campanhas/grupos/anúncios quando disponíveis |
| Contratos e comissões | Documentos autorizados, assinatura/validação, valores e situação da apuração |
| Integrações | Conectado, erro, atualização e necessidade de reconexão; nunca exibir tokens |

Gestão prioriza desktop, mas deve continuar navegável no celular. Marketing e administrativo veem apenas telas e dados permitidos pelo seu papel. Esconder menu não substitui autorização da API.

## Área das atendentes

Navegação móvel proposta: Meus leads, Bolsão, Agenda, Perfil. No desktop, a mesma área usa listas/tabelas mais amplas e ficha lateral quando útil.

### Meus leads

- Reservas novas destacadas com resumo, origem disponível, unidade e contador.
- Botão principal `Assumir e abrir WhatsApp`.
- Após aceite, oportunidade permanece na lista de atendimento; mostrar próxima ação e pendências comerciais.
- Nome de perfil ausente tem indicação neutra, sem nome inventado.
- Telefone e observações pessoais não entram no resumo compartilhado do bolsão ou notificações de tela bloqueada.

### Bolsão

- Lista de oportunidades elegíveis com tempo de espera e resumo mínimo.
- Botão `Assumir e abrir WhatsApp`, protegido por comando no servidor.
- Vencedor só é exibido após confirmação. Demais telas atualizam/removem o cartão.
- Mensagem para conflito: `Este lead já foi assumido. Atualizamos o bolsão.`
- Sem internet, mostrar indisponibilidade para assumir; não confirmar nem deixar aceite em fila offline.

### Ficha do lead

- Identificação: nome, telefone/WhatsApp, Instagram e e-mail opcionais.
- Interesse: procedimento, unidade e observações.
- Trabalho: etapa, próxima ação e data de retorno.
- Avaliações: data, horário, local/unidade e situação, com histórico de remarcações.
- Comercial: informações permitidas, contrato e valor quando aplicável.
- Origem: aquisição e canal de entrada separados; evidência e desconhecidos explícitos.
- Histórico: distribuição, aceite e atividades; indicar autor das atualizações.

Formulários devem aceitar cadastro incompleto e solicitar dados conforme avanço. Mostrar salvamento, erro e conflito de edição. Não marcar venda como validada apenas porque um arquivo foi anexado.

## Abertura do WhatsApp

1. Usuária toca no botão e aplicativo solicita aceite autenticado.
2. Servidor confirma posse; aplicativo mostra estado confirmado.
3. Aplicativo tenta abrir o contato no WhatsApp com mensagem inicial sugerida quando configurada.
4. Se houver bloqueio do navegador, aplicativo incorreto ou falha, manter posse e apresentar botão explícito para tentar novamente e opção de copiar contato ao usuário autorizado.

O comportamento deve ser testado em Android/iPhone com WhatsApp e WhatsApp Business, além de desktop. Não afirmar que o envio aconteceu. Não marcar `respondeu` apenas por acionamento do link. A mensagem sugerida é editável e só é enviada pela atendente no WhatsApp.

Se a rede cair durante o aceite, mostrar estado pendente de confirmação e consultar novamente usando a mesma chave de idempotência. Não permitir que um segundo toque crie uma operação concorrente diferente.

## Notificações e atualização

- Push avisa nova reserva ou disponibilidade no bolsão, respeitando permissão do aparelho.
- Notificação abre a tela autenticada; clicar nela não assume automaticamente.
- Aviso não deve conter telefone, procedimento clínico ou conteúdo pessoal na tela bloqueada.
- Permitir verificar configuração de notificações e testar o próprio dispositivo.
- Aplicativo aberto recebe avisos de alteração e busca dados atuais. Ao retornar do WhatsApp, reconectar e atualizar.
- Contador deriva de `expires_at` e horário do servidor; não decide posse localmente.
- Exibir falha de conexão/última atualização; cartões antigos não garantem disponibilidade.

PWA é candidata para a primeira distribuição, não decisão fechada. iPhone exige instalação na tela inicial e autorização compatível para Web Push. App de loja com Capacitor é alternativa se escolhida após testes. Nenhuma modalidade garante que um aparelho offline, sem permissão ou em modo de foco exibirá o aviso imediatamente.

## Relatórios e linguagem

- Rótulos distintos: `Cliques`, `Contatos recebidos`, `Oportunidades novas`, `Leads assumidos`, `Tempo até aceite`, `Contratos assinados`.
- Mostrar separadamente `Conversões informadas pela plataforma` e `Resultados atribuídos no CRM`.
- Exibir última atualização, moeda, período/fuso e cobertura de atribuição.
- Ausência de origem: `Não identificada`; não substituir por `Orgânico`.
- Cliques Meta em link separados de cliques gerais. Não comparar métricas com definições diferentes sem indicar a diferença.
- Valor contratado separado de valor recebido; retorno por período de aquisição e data de fechamento claramente identificado.

## Estados e acessibilidade

Todas as telas principais precisam de estados de carregamento, lista vazia, erro, acesso negado e dados desatualizados. Textos e ícones complementam cores de situação. Foco visível, navegação por teclado, rótulos de campos e alvos de toque confortáveis são requisitos.

Cache offline, se utilizado, deve priorizar a estrutura visual e evitar persistência indiscriminada de dados pessoais. Alterações críticas exigem conexão. Logout remove dados sensíveis mantidos pelo aplicativo e encerra assinaturas/sessões conforme política definida.

## Validação visual e funcional

- Layouts móvel estreito, tablet e desktop sem ações inacessíveis.
- Fluxo completo de reserva, aceite, abertura de WhatsApp e retorno ao CRM nos aparelhos reais.
- Notificações com app fechado, tela bloqueada, rede móvel e Wi-Fi; documentar resultados e limitações.
- Duas atendentes vendo o mesmo cartão não podem receber confirmação de posse simultânea.
- Logo, paleta e Montserrat coerentes nas áreas de gestão e atendimento.
- Erros de API e conflitos deixam a interface recuperável, sem indicar sucesso falso.
- Revisão de contraste em botões dourados, textos auxiliares e estados de urgência.
