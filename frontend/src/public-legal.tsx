import { useEffect, type ReactNode } from 'react';
import { ArrowLeft, ExternalLink, ShieldCheck, Trash2 } from 'lucide-react';

export type PublicLegalPageName = 'privacy' | 'deletion';

const LAST_UPDATED = '24 de setembro de 2026';
const SITE_URL = 'https://artistitransplantecapilar.com.br/';
const INSTAGRAM_URL = 'https://www.instagram.com/artistitransplantecapilar/';
const WHATSAPP_URL = 'https://wa.me/5548992078764';

function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink size={14} aria-hidden="true" />
    </a>
  );
}

function LegalLayout({
  title,
  summary,
  icon,
  children,
}: {
  title: string;
  summary: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="public-legal-page">
      <header className="public-legal-header">
        <a className="public-legal-brand" href="/" aria-label="Voltar para o Artisti CRM">
          <img src="/artisti-logo.webp" alt="Artisti Transplante Capilar" />
        </a>
      </header>
      <main className="public-legal-main">
        <a className="public-legal-back" href="/">
          <ArrowLeft size={17} aria-hidden="true" />
          Voltar ao CRM
        </a>
        <article className="public-legal-card">
          <div className="public-legal-title">
            <span aria-hidden="true">{icon}</span>
            <div>
              <span className="eyebrow">ARTISTI CRM</span>
              <h1>{title}</h1>
            </div>
          </div>
          <p className="public-legal-summary">{summary}</p>
          <p className="public-legal-updated">Última atualização: {LAST_UPDATED}</p>
          <div className="public-legal-content">{children}</div>
        </article>
      </main>
      <footer className="public-legal-footer">
        <span>Artisti Transplante Capilar</span>
        <nav aria-label="Documentos legais">
          <a href="/politica-de-privacidade">Política de Privacidade</a>
          <a href="/exclusao-de-dados">Exclusão de dados</a>
        </nav>
      </footer>
    </div>
  );
}

function PrivacyPolicy() {
  return (
    <LegalLayout
      title="Política de Privacidade"
      summary="Esta política explica como a Artisti Transplante Capilar trata dados pessoais no ARTISTI CRM e nos canais de atendimento integrados."
      icon={<ShieldCheck size={28} />}
    >
      <section>
        <h2>1. Quem é responsável pelos dados</h2>
        <p>
          A Artisti Transplante Capilar é responsável pelas decisões sobre o tratamento de dados
          pessoais realizado no ARTISTI CRM. O sistema é uma ferramenta interna de relacionamento,
          atendimento e organização comercial usada por pessoas autorizadas da Artisti.
        </p>
      </section>

      <section>
        <h2>2. A quem e a quais canais esta política se aplica</h2>
        <p>
          Esta política se aplica às pessoas que entram em contato com a Artisti por Instagram,
          WhatsApp ou outro canal registrado no CRM, assim como aos profissionais autorizados que
          utilizam a plataforma. Ela complementa as políticas próprias da Meta, do Instagram, do
          WhatsApp e de outros serviços utilizados para transmitir as comunicações.
        </p>
      </section>

      <section>
        <h2>3. Dados que podem ser tratados</h2>
        <p>Dependendo do canal e da interação, o ARTISTI CRM poderá tratar:</p>
        <ul>
          <li>
            dados de identificação e contato, como nome, telefone, e-mail, nome de usuário e
            identificador técnico do Instagram;
          </li>
          <li>
            nome de exibição e endereço temporário da foto do perfil disponibilizados pela API do
            Instagram;
          </li>
          <li>
            conteúdo de mensagens, respostas, anexos, identificadores das mensagens, datas, horários
            e estado de entrega ou leitura quando disponibilizado pelo canal;
          </li>
          <li>
            informações de atendimento, como interesse declarado, unidade, qualificação do contato,
            agendamentos, próximas ações, responsável e histórico operacional;
          </li>
          <li>
            dados de origem e atribuição, como canal, campanha, anúncio ou referência que levou ao
            contato, quando fornecidos pela Meta;
          </li>
          <li>
            informações técnicas e de segurança, como sessão, registros de acesso, eventos de
            auditoria e assinatura de notificações do navegador.
          </li>
        </ul>
        <p>
          O CRM não substitui prontuário médico. Evite enviar exames, documentos clínicos ou outras
          informações sensíveis que não sejam necessárias para o primeiro atendimento. Caso uma
          pessoa forneça voluntariamente informações de saúde em uma conversa, o acesso será
          limitado ao atendimento e às finalidades legítimas aplicáveis.
        </p>
      </section>

      <section>
        <h2>4. Como os dados são obtidos</h2>
        <p>Os dados podem ser recebidos:</p>
        <ul>
          <li>diretamente da pessoa durante uma conversa ou solicitação de atendimento;</li>
          <li>pelas APIs e webhooks oficiais do Instagram, WhatsApp e demais produtos da Meta;</li>
          <li>por cadastro ou atualização realizados por profissionais autorizados da Artisti;</li>
          <li>por eventos técnicos necessários à segurança e ao funcionamento da plataforma.</li>
        </ul>
      </section>

      <section>
        <h2>5. Para que os dados são utilizados</h2>
        <ul>
          <li>receber, organizar e responder solicitações de atendimento;</li>
          <li>identificar o contato e manter o histórico da conversa no canal correto;</li>
          <li>
            distribuir atendimentos entre profissionais autorizados e registrar responsabilidades;
          </li>
          <li>registrar interesses, retornos, avaliações e agendamentos solicitados;</li>
          <li>medir a origem de contatos e o desempenho de campanhas, quando aplicável;</li>
          <li>evitar duplicidades, fraude, acesso indevido e falhas operacionais;</li>
          <li>cumprir obrigações legais, regulatórias e exercer direitos em processos.</li>
        </ul>
        <p>
          A Artisti não vende dados pessoais. Os dados recebidos das plataformas da Meta são usados
          somente para prestar e melhorar as funções de atendimento e gestão exibidas no CRM.
        </p>
      </section>

      <section>
        <h2>6. Bases e limites do tratamento</h2>
        <p>
          O tratamento é realizado conforme a finalidade da interação e a legislação aplicável,
          podendo se apoiar na execução de procedimentos solicitados pela pessoa, no consentimento
          quando necessário, no cumprimento de obrigação legal ou regulatória e em interesses
          legítimos compatíveis com os direitos do titular. Dados sensíveis somente serão tratados
          quando houver fundamento legal apropriado e necessidade para a finalidade informada.
        </p>
      </section>

      <section>
        <h2>7. Compartilhamento e operadores</h2>
        <p>O acesso poderá ocorrer por:</p>
        <ul>
          <li>profissionais da Artisti autorizados de acordo com sua função;</li>
          <li>Meta, Instagram e WhatsApp, conforme a comunicação solicitada pela pessoa;</li>
          <li>
            fornecedores de hospedagem, banco de dados, entrega de notificações, monitoramento e
            suporte técnico, exclusivamente para operar e proteger o serviço;
          </li>
          <li>autoridades ou terceiros quando houver obrigação legal ou ordem válida.</li>
        </ul>
        <p>
          Alguns fornecedores podem processar dados em outros países. Nesses casos, são adotadas as
          medidas contratuais e de segurança aplicáveis à transferência e à proteção dos dados.
        </p>
      </section>

      <section>
        <h2>8. Google e notificações do navegador</h2>
        <p>
          Atualmente, o ARTISTI CRM não solicita autorização OAuth nem acessa dados pessoais de uma
          Conta Google. Dependendo do navegador ou dispositivo, notificações web podem ser entregues
          por um provedor de push, inclusive infraestrutura do Google, sem conceder ao CRM acesso ao
          conteúdo da Conta Google. Qualquer futura integração que acesse dados de APIs do Google
          deverá ser informada nesta política antes de ser ativada e obedecerá à Política de Dados
          do Usuário dos Serviços de API do Google, incluindo os requisitos de Uso Limitado.
        </p>
      </section>

      <section>
        <h2>9. Armazenamento, retenção e segurança</h2>
        <p>
          Os dados são mantidos pelo período necessário ao atendimento, à gestão do relacionamento,
          à segurança e às obrigações legais aplicáveis. A definição do prazo considera a existência
          de relacionamento ativo, solicitações pendentes, prevenção de fraude e necessidade de
          defesa de direitos. Encerrada a necessidade, os dados serão excluídos ou anonimizados,
          ressalvadas as hipóteses de conservação permitidas por lei.
        </p>
        <p>
          O CRM utiliza conexão HTTPS, autenticação, controle de acesso por função, validação de
          eventos recebidos, registros de auditoria e outras salvaguardas destinadas a reduzir
          acesso, alteração, divulgação ou perda não autorizados. Nenhum sistema é totalmente imune
          a riscos, mas as medidas são revistas de acordo com a natureza do serviço.
        </p>
      </section>

      <section>
        <h2>10. Direitos da pessoa titular</h2>
        <p>
          Nos termos da legislação aplicável, a pessoa poderá solicitar confirmação de tratamento,
          acesso, correção, informação sobre compartilhamento, portabilidade quando cabível,
          anonimização, bloqueio ou exclusão, além de revogação do consentimento e revisão das
          decisões aplicáveis. A Artisti poderá solicitar informações mínimas para confirmar a
          identidade e proteger os dados contra pedidos indevidos.
        </p>
        <p>
          Consulte as <a href="/exclusao-de-dados">instruções para exclusão de dados</a> para
          iniciar uma solicitação relacionada ao ARTISTI CRM.
        </p>
      </section>

      <section>
        <h2>11. Cookies e sessão</h2>
        <p>
          O CRM utiliza cookie de sessão estritamente necessário para autenticar profissionais
          autorizados. A página pública desta política não exige login. Eventuais tecnologias do
          site institucional seguem as informações disponibilizadas no próprio site.
        </p>
      </section>

      <section>
        <h2>12. Atualizações e contato</h2>
        <p>
          Esta política poderá ser atualizada para refletir mudanças legais, operacionais ou nas
          integrações. A data da versão vigente será sempre indicada no início desta página.
        </p>
        <p>Para dúvidas ou exercício de direitos, utilize um dos canais oficiais:</p>
        <ul className="public-legal-contact-list">
          <li>
            <ExternalAnchor href={SITE_URL}>Site da Artisti</ExternalAnchor>
          </li>
          <li>
            <ExternalAnchor href={INSTAGRAM_URL}>
              Instagram @artistitransplantecapilar
            </ExternalAnchor>
          </li>
          <li>
            <ExternalAnchor href={WHATSAPP_URL}>WhatsApp oficial</ExternalAnchor>
          </li>
        </ul>
      </section>
    </LegalLayout>
  );
}

function DataDeletion() {
  return (
    <LegalLayout
      title="Exclusão de dados"
      summary="Veja como solicitar a exclusão de informações pessoais associadas a um atendimento registrado no ARTISTI CRM."
      icon={<Trash2 size={28} />}
    >
      <section>
        <h2>Como solicitar</h2>
        <p>
          Envie uma mensagem por um dos canais oficiais abaixo com o texto “Solicitação de exclusão
          de dados do ARTISTI CRM”:
        </p>
        <ul className="public-legal-contact-list">
          <li>
            <ExternalAnchor href={INSTAGRAM_URL}>
              Direct do Instagram @artistitransplantecapilar
            </ExternalAnchor>
          </li>
          <li>
            <ExternalAnchor href={WHATSAPP_URL}>WhatsApp oficial da Artisti</ExternalAnchor>
          </li>
          <li>
            <ExternalAnchor href={SITE_URL}>Canais publicados no site da Artisti</ExternalAnchor>
          </li>
        </ul>
      </section>

      <section>
        <h2>Informações necessárias</h2>
        <p>Para localizar o registro correto, informe somente:</p>
        <ul>
          <li>seu nome;</li>
          <li>o canal utilizado para falar com a Artisti;</li>
          <li>seu nome de usuário do Instagram ou número de telefone usado no atendimento;</li>
          <li>uma data aproximada do contato, se souber.</li>
        </ul>
        <p>
          Nunca envie senha, token, código de autenticação ou documento completo. Informações
          adicionais poderão ser solicitadas apenas quando forem indispensáveis para confirmar a
          identidade e impedir a exclusão indevida de dados de outra pessoa.
        </p>
      </section>

      <section>
        <h2>O que será analisado para exclusão</h2>
        <p>
          Confirmada a identidade e a abrangência do pedido, poderão ser excluídos os dados de
          contato e identidade de canal, o cadastro do lead, as conversas e mensagens armazenadas,
          referências de anexos, atribuições de origem, agendamentos e o histórico operacional
          associado. O CRM poderá conservar somente um identificador técnico irreversível do evento
          já excluído para impedir que uma repetição automática recrie o registro.
        </p>
      </section>

      <section>
        <h2>Exceções e confirmação</h2>
        <p>
          Determinadas informações poderão ser conservadas quando houver obrigação legal ou
          regulatória, necessidade de segurança, prevenção de fraude ou exercício regular de
          direitos. A pessoa será informada sobre a conclusão do pedido ou sobre eventual motivo
          legítimo de conservação, conforme a legislação aplicável.
        </p>
      </section>

      <section>
        <h2>Desconectar o aplicativo no Instagram</h2>
        <p>
          Também é possível remover a autorização do aplicativo nas configurações de “Apps e sites”
          do Instagram. Essa remoção interrompe novos acessos autorizados, mas não substitui o
          pedido de exclusão dos registros já recebidos pelo ARTISTI CRM.
        </p>
      </section>

      <section>
        <h2>Mais informações</h2>
        <p>
          Consulte a <a href="/politica-de-privacidade">Política de Privacidade do ARTISTI CRM</a>{' '}
          para conhecer as categorias de dados tratadas, suas finalidades e os direitos disponíveis.
        </p>
      </section>
    </LegalLayout>
  );
}

export function PublicLegalPage({ page }: { page: PublicLegalPageName }) {
  useEffect(() => {
    const title = page === 'privacy' ? 'Política de Privacidade' : 'Exclusão de dados';
    document.title = `${title} | Artisti CRM`;
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description)
      description.content =
        page === 'privacy'
          ? 'Política de Privacidade do ARTISTI CRM.'
          : 'Instruções para solicitar exclusão de dados do ARTISTI CRM.';
  }, [page]);

  return page === 'privacy' ? <PrivacyPolicy /> : <DataDeletion />;
}
