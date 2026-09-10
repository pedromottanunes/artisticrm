# Especificação do backend

Status: especificação-alvo. O núcleo inicial já está implementado; o [README](../README.md) delimita funcionalidades entregues e pendentes. Nenhuma integração externa está conectada. O caminho de publicação agora é GitHub → Render, conforme [DEPLOY.md](../DEPLOY.md).

## Arquitetura

Monólito modular em Node.js/TypeScript com Fastify. API e worker executam o mesmo domínio em processos separados. PostgreSQL é a fonte de verdade para cadastros, regras, reservas, histórico e tarefas persistentes. pg-boss é o candidato para tarefas; não pressupor execução única de efeitos externos: os consumidores devem ser idempotentes.

Supabase é candidato para PostgreSQL, Auth e Storage privado. Regras de negócio e autorização permanecem explícitas na API, independentemente do provedor. Frontend não pode escrever diretamente em reservas, propriedade ou comissões. Credenciais privilegiadas não são enviadas ao navegador.

Módulos: identidade/permissões, contatos, oportunidades, distribuição, atividades/agendamentos, contratos/comissões, entrada WhatsApp, notificações, rastreamento, relatórios de mídia e auditoria.

## Entrada de mensagens

1. Verificar assinatura da requisição e conta/número destinatário autorizado.
2. Persistir evento de entrada e tarefa de processamento na mesma transação; responder sucesso somente após persistência. Falha de armazenamento deve permitir nova tentativa do provedor.
3. Deduplicar mensagens por integração, número receptor e identificador externo. Não tratar notificações de status como novas mensagens ou leads.
4. Preservar o identificador do remetente e normalizar telefone sem fundir automaticamente números diferentes.
5. Localizar contato e oportunidade aberta; mensagens subsequentes atualizam a entrada existente. Serializar criação por identidade para impedir duas oportunidades em entradas simultâneas.
6. Para nova oportunidade elegível, distribuir e registrar notificações pendentes. Enriquecimento da campanha acontece depois.

Mensagem sem texto, como áudio ou imagem, também pode originar contato. Registrar tipo e metadados necessários; política de retenção de texto/mídia inicial deve ser definida. Não implementar histórico completo de conversas das atendentes.

Nova mensagem ao central após aceite fica vinculada à oportunidade e gera aviso ao responsável. O central permanece sem respostas automáticas. Contatos bloqueados, spam ou retorno de paciente com oportunidade encerrada exigem classificação/política antes de distribuição indiscriminada.

## Modelo de dados

| Entidade | Dados e responsabilidade |
| --- | --- |
| Usuário e perfil | Identidade de login, papel, situação e escopo de acesso |
| Atendente e participação na fila | Usuário, ordem, habilitação e histórico de alterações |
| Unidade | Cadastro de unidade; não determina fila automaticamente |
| Contato | Nome, identidades de telefone/WhatsApp, Instagram e e-mail opcionais |
| Oportunidade | Contato, interesse, unidade, etapa comercial, responsável e próxima ação |
| Distribuição | Oportunidade, estado, destinatário reservado, vencimento, versão e aceite |
| Fila | Configuração, cursor persistente e sequência de atribuições |
| Atividade | Observação, tarefa, prazo, conclusão e autor |
| Agendamento | Tipo, início com fuso, unidade, situação e histórico de remarcações |
| Contrato | Oportunidade, valor, moeda, documento privado, assinatura e validação |
| Comissão | Beneficiário, versão da regra, base, valor, situação e ajustes |
| Interação de aquisição | Referência opaca, página, botão, UTMs e identificadores disponíveis |
| Evidência de atribuição | Tipo, fonte, interação associada, data e correções justificadas |
| Métrica de anúncios | Plataforma, conta, data, nível/ID de campanha/anúncio, métrica e segmentação |
| Evento de entrada | Identificador externo, processamento, tentativas e metadados necessários |
| Evento de domínio e entrega pendente | Alteração de negócio e trabalho durável a executar |
| Assinatura de notificação | Usuário, dispositivo, endereço de entrega e estado |
| Auditoria | Ator, ação, alvo, horário e alteração, com acesso restrito |

Uma pessoa pode ter mais de uma oportunidade ao longo do tempo. Definir o escopo de unicidade de oportunidade ativa e a política de reentrada antes de implementar índices. Não unir contatos apenas por nome ou horário. Datas em UTC no armazenamento; exibir no fuso configurado. Valores monetários em centavos/decimal exato, nunca ponto flutuante.

## Distribuição e concorrência

Estados de distribuição: `RESERVED`, `POOL`, `CLAIMED`, `CANCELLED`. Oportunidade ainda sem atribuição pode estar em processamento ou pendência operacional visível à gestão. Esses estados são independentes do funil comercial.

- Dentro de uma transação curta, bloquear o cursor da fila, selecionar próximo participante habilitado, criar reserva, avançar cursor e gravar histórico/tarefas. Não chamar APIs externas segurando bloqueios.
- Ordem é a sequência de atribuição confirmada no banco. Mensagens podem chegar fora de ordem do provedor; guardar horário de origem separadamente.
- Sem participantes habilitados, manter pendência visível e alertar gestão; não descartar entrada.
- Salvar `reserved_at`, `expires_at` e versão da configuração. Mudança futura de prazo não altera reservas existentes silenciosamente.
- Não usar temporizador de navegador ou memória do servidor como autoridade de vencimento.
- Worker processa expirações com novas tentativas; rotina de reconciliação encontra reservas vencidas e trabalhos pendentes após reinícios.
- Consultas e aceite calculam elegibilidade pelo prazo persistido. Reserva vencida equivale a bolsão, mesmo antes da tarefa materializar a transição.
- Aceite precisa verificar participante, estado, vencimento e versão. Aceite exclusivo exige reserva válida do usuário; aceite de bolsão exige disponibilidade compartilhada. Solicitação exclusiva vencida retorna conflito e permite atualizar a tela, sem ganhar prioridade implicitamente.
- Atualizar proprietário, distribuição, auditoria e eventos pendentes na mesma transação. Apenas um vencedor é possível.
- Repetição da mesma solicitação deve recuperar o resultado anterior. Duplo toque ou resposta perdida não cria outro aceite.
- A passagem ao bolsão não avança o cursor do rodízio.
- Atendente original pode disputar como participante comum: proposta a confirmar.
- Após aceite, falha ao abrir WhatsApp não devolve automaticamente ao bolsão. Permitir reabertura e transferência administrativa auditada.
- Gestor pode transferir com justificativa; comandos antigos ficam inválidos pela versão. Registrar dono anterior e novo.

## Cadastro e comercial

Cadastro automático exige identidade de WhatsApp, não nome completo. Cadastro manual precisa de identificação mínima e decisão de responsável/distribuição conforme política validada. Telefone completo fica restrito ao proprietário autorizado e à gestão; no bolsão entregar resumo mínimo.

Etapas comerciais propostas: `TO_QUALIFY`, `EVALUATION_SCHEDULED`, `NEGOTIATION`, `CONTRACT_PENDING`, `WON`, `LOST`. Avaliação realizada é situação de agendamento, podendo virar etapa adicional se necessário.

Guardar cancelamentos e remarcações. Permitir histórico de múltiplas avaliações. Atualizar etapa não deve apagar agendamento anterior.

Contrato assinado precisa de validação administrativa ou evento de provedor confiável. Assinatura é condição necessária para comissão, não regra financeira completa. Beneficiário e fórmula ficam congelados no registro de apuração; mudanças de proprietário posteriores não reescrevem comissões. Cancelamentos geram ajustes auditados. Separar valor contratado de recebimentos; registrar recebimentos somente se incluídos no escopo operacional.

## Aquisição e mídia paga

### Site, GTM e associação ao contato

- Instrumentar as duas landing pages com contrato de eventos comum.
- `whatsapp_cta_click`: `page_id`, `button_id`, `button_text`, `section_id`, `occurred_at`, referência opaca e metadados de origem permitidos.
- Capturar UTMs e identificadores disponíveis na entrada da página, antes que se percam durante a navegação. GTM envia evento analítico ao destino configurado; backend registra a interação para futura associação.
- Mensagem pré-preenchida leva referência opaca, sem nome, telefone ou dados clínicos no código. A referência só correlaciona eventos, não autoriza acesso a cadastro.
- Cliques não criam oportunidades. O cadastro automático acontece com a mensagem recebida.
- Bloqueio de scripts, recusa de armazenamento, timeout do rastreamento ou remoção do código não devem impedir acesso ao WhatsApp. Usar link de contingência e aceitar origem parcial/desconhecida.
- Em anúncio direto para WhatsApp, preservar `referral` quando existir e enriquecer dados posteriormente.
- Guardar primeira origem, interações posteriores e modelo de atribuição; nunca sobrescrever a origem original por um clique posterior sem histórico.
- Canal de entrada `whatsapp` é independente da aquisição `google / cpc`, `meta / paid_social`, indicação ou desconhecida.
- Coleta analítica respeita configuração de consentimento aplicável; não colocar informações pessoais ou clínicas no dataLayer enviado às plataformas.

### Meta Ads e Google Ads

- Integrações inicialmente somente leitura, com contas explicitamente autorizadas.
- Sincronizar gastos, impressões, cliques relevantes, ações/conversões disponíveis e dimensões de campanha/anúncio. Preservar diferença entre cliques gerais e cliques no link.
- Importar em segundo plano com paginação, limites, novas tentativas, carga histórica e reprocessamento de períodos recentes para atualizações tardias.
- Chaves únicas de métricas incluem conta, data, nível, objeto e segmentação; não somar campanha e seus anúncios como despesas distintas.
- Preservar fuso, moeda, origem e horário de atualização de cada conta. Não somar moedas diferentes sem conversão explícita.
- Relatórios mostram métricas declaradas pelas plataformas separadas de leads e vendas comprovados no CRM.
- Guardar credenciais no servidor; expiração ou revogação gera estado de reconexão sem interromper distribuição.
- Google Ads requer autenticação e developer token com acesso adequado; Meta Ads, WhatsApp e mensageria são produtos/permissões diferentes.
- Não exportar automaticamente conversões médicas, listas de pacientes ou eventos clínicos. Atribuição interna não depende dessa exportação.

## Operação e acesso

- Perfil atendente: seus registros, resumo do bolsão autorizado e ações elegíveis.
- Administrativo: contratos e financeiro conforme autorização, sem privilégios técnicos por padrão.
- Gestor: visão operacional, regras e transferências.
- Marketing: relatórios de aquisição, sem acesso irrestrito a documentos e dados dos pacientes.
- Sessões, notificações e acesso devem ser revogados no desligamento. URLs de arquivos privados têm validade curta e acesso validado.
- Eventos em tempo real notificam mudança; cliente busca estado atual autorizado. Push não é prova de visualização ou atendimento.
- Publicar eventos somente após commit, com entrega pendente durável. Falha após enviar pode repetir uma notificação: usar identificadores estáveis e descartar avisos já obsoletos.
- Monitorar recebimento e processamento de webhooks, atraso de filas, reservas vencidas, contatos sem destino, falhas de push e sincronização de mídia.
- Logs técnicos sem tokens, conteúdo clínico ou payload pessoal completo. Política de retenção deve abranger banco, tarefas, logs e backups.
- Banco com recuperação definida e teste de restauração; arquivos exigem estratégia própria. API/worker sem suspensão automática incompatível com atendimento contínuo.

## Testes de aceitação prioritários

1. Reenvio de uma mensagem gera uma entrada lógica e uma atribuição.
2. Mensagens diferentes simultâneas do mesmo contato não duplicam oportunidade ativa.
3. Oito oportunidades novas seguem duas voltas do rodízio, com ordem auditável.
4. Quatro aceites concorrentes do bolsão resultam em exatamente um dono.
5. Aceite concorrente com vencimento respeita horário e versão do servidor.
6. Worker parado não estende exclusividade; recuperação processa pendências.
7. Resposta perdida após aceite é recuperada por solicitação idempotente.
8. Atendente sem permissão não obtém telefone nem assume registro fora do seu escopo.
9. Rastreamento indisponível permite abrir WhatsApp e cadastrar origem desconhecida.
10. Falha em Meta/Google Ads não impede entrada, distribuição ou aceite.
11. Mudança de proprietário não altera comissão já apurada.
12. Nova mensagem ao central mantém o responsável da oportunidade aberta.
