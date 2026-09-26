import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Download,
  ExternalLink,
  FileQuestion,
  Inbox,
  MessageCircle,
  RefreshCw,
  Send,
} from 'lucide-react';
import {
  api,
  ApiError,
  stateLabels,
  type ConversationMessage,
  type ConversationSummary,
  type User,
} from './api';
import { Empty } from './components';

interface ListResponse {
  configured: boolean;
  conversations: ConversationSummary[];
}

interface ThreadResponse {
  conversation_id: string;
  opportunity_id: string;
  can_send: boolean;
  messages: ConversationMessage[];
}

const time = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

const imageAttachmentTypes = new Set(['image', 'photo', 'animated_image']);
const audioAttachmentTypes = new Set(['audio', 'voice', 'voice_message']);

function MediaAttachment({
  attachment,
  downloadUrl,
}: {
  attachment: ConversationMessage['attachments'][number];
  downloadUrl: string;
}) {
  const [failed, setFailed] = useState(false);
  const type = attachment.type.toLowerCase();

  if (!attachment.url || failed)
    return (
      <span className="message-media-unavailable" role="status">
        <FileQuestion size={16} aria-hidden="true" />
        Mídia indisponível
      </span>
    );

  if (imageAttachmentTypes.has(type))
    return (
      <div className="message-image-wrap">
        <a
          className="message-image-link"
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Abrir imagem em tamanho original"
        >
          <img
            className="message-image"
            src={attachment.url}
            alt="Imagem recebida pelo Instagram"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </a>
        <a className="message-image-download" href={downloadUrl} download="imagem-instagram">
          <Download size={14} aria-hidden="true" />
          Baixar imagem
        </a>
      </div>
    );

  if (audioAttachmentTypes.has(type))
    return (
      <audio
        className="message-audio"
        src={attachment.url}
        controls
        preload="metadata"
        onError={() => setFailed(true)}
      >
        Seu navegador não consegue reproduzir este áudio.
      </audio>
    );

  return (
    <a className="message-attachment-link" href={attachment.url} target="_blank" rel="noreferrer">
      Abrir {type === 'ig_reel' ? 'reel no Instagram' : attachment.type}
      <ExternalLink size={13} aria-hidden="true" />
    </a>
  );
}

export function InstagramInbox({
  user,
  connected,
  targetOpportunityId,
  onTargetConsumed,
  onOpenLead,
  onNotice,
  onConnectionChange,
  onSessionExpired,
}: {
  user: User;
  connected: boolean;
  targetOpportunityId: string;
  onTargetConsumed: () => void;
  onOpenLead: (id: string) => void;
  onNotice: (message: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => void;
}) {
  const [configured, setConfigured] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const sendCommand = useRef<{ text: string; key: string } | null>(null);
  const selectedIdRef = useRef('');
  const listSequence = useRef(0);
  const threadSequence = useRef(0);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) onSessionExpired();
      else {
        if (!(error instanceof ApiError)) onConnectionChange(false);
        onNotice((error as Error).message);
      }
    },
    [onConnectionChange, onNotice, onSessionExpired],
  );

  const loadThread = useCallback(
    async (id: string, quiet = false) => {
      if (!id) return;
      const sequence = ++threadSequence.current;
      try {
        const result = await api<ThreadResponse>(`/conversations/${id}/messages`);
        if (sequence !== threadSequence.current) return;
        setThread(result);
        onConnectionChange(true);
        void api(`/conversations/${id}/read`, { method: 'POST', body: '{}' }).catch(() => {});
      } catch (error) {
        if (sequence !== threadSequence.current) return;
        if (!quiet) handleError(error);
      }
    },
    [handleError, onConnectionChange],
  );

  const refresh = useCallback(
    async (quiet = false) => {
      const sequence = ++listSequence.current;
      try {
        const view = user.role === 'manager' ? 'all' : 'mine';
        const result = await api<ListResponse>(`/conversations?view=${view}`);
        if (sequence !== listSequence.current) return;
        setConfigured(result.configured);
        setConversations(result.conversations);
        const targeted = targetOpportunityId
          ? result.conversations.find((item) => item.opportunity_id === targetOpportunityId)
          : undefined;
        const next = targeted
          ? targeted.id
          : result.conversations.some((item) => item.id === selectedIdRef.current)
            ? selectedIdRef.current
            : (result.conversations[0]?.id ?? '');
        selectedIdRef.current = next;
        setSelectedId(next);
        if (targeted) onTargetConsumed();
        if (next) void loadThread(next, quiet);
        else setThread(null);
        onConnectionChange(true);
      } catch (error) {
        if (sequence !== listSequence.current || quiet) return;
        handleError(error);
      } finally {
        if (sequence === listSequence.current) setLoading(false);
      }
    },
    [handleError, loadThread, onConnectionChange, onTargetConsumed, targetOpportunityId, user.role],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const select = (id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
    setThread(null);
    void loadThread(id);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !selectedId || !thread?.can_send || sending || !connected) return;
    const command =
      sendCommand.current?.text === text ? sendCommand.current : { text, key: crypto.randomUUID() };
    sendCommand.current = command;
    setSending(true);
    try {
      const result = await api<{ status: string }>(`/conversations/${selectedId}/messages`, {
        method: 'POST',
        headers: { 'Idempotency-Key': command.key },
        body: JSON.stringify({ text }),
      });
      if (result.status === 'sent') {
        sendCommand.current = null;
        setDraft('');
      } else
        onNotice(
          'O envio ainda não foi confirmado pela Meta. Confira a conversa antes de tentar novamente.',
        );
      await loadThread(selectedId);
      await refresh(true);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) sendCommand.current = null;
      handleError(error);
    } finally {
      setSending(false);
    }
  };

  if (loading)
    return (
      <section className="instagram-inbox panel">
        <div className="inbox-loading">
          <span className="loader" /> Carregando conversas…
        </div>
      </section>
    );

  if (!configured)
    return (
      <section className="instagram-inbox panel">
        <Empty
          title="Instagram ainda não conectado"
          description="Configure as variáveis da integração e publique o webhook para receber conversas aqui."
        />
      </section>
    );

  return (
    <section className="instagram-inbox" aria-label="Caixa de entrada do Instagram">
      <aside className="inbox-list panel">
        <header>
          <div>
            <span>INSTAGRAM DIRECT</span>
            <h2>Conversas</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Atualizar conversas"
            onClick={() => void refresh()}
          >
            <RefreshCw size={17} />
          </button>
        </header>
        <div className="inbox-conversations">
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={selectedId === conversation.id ? 'active' : ''}
              onClick={() => select(conversation.id)}
            >
              <span className="instagram-avatar">
                <MessageCircle size={18} />
                {conversation.profile_picture_url && (
                  <img
                    src={conversation.profile_picture_url}
                    alt=""
                    referrerPolicy="no-referrer"
                    onError={(event) => event.currentTarget.remove()}
                  />
                )}
              </span>
              <span>
                <strong>{conversation.contact_name}</strong>
                <small>
                  {conversation.instagram_username
                    ? `@${conversation.instagram_username}`
                    : (stateLabels[conversation.state] ?? conversation.state)}
                </small>
              </span>
              <time>{time(conversation.last_message_at)}</time>
            </button>
          ))}
          {!conversations.length && (
            <div className="inbox-empty-list">
              <Inbox size={27} />
              <strong>Nenhuma conversa</strong>
              <span>
                {user.role === 'manager'
                  ? 'Os novos Directs aparecerão aqui.'
                  : 'Depois de assumir um lead do Instagram, a conversa aparecerá aqui.'}
              </span>
            </div>
          )}
        </div>
      </aside>

      <div className="inbox-thread panel">
        {!selectedId || !thread ? (
          <Empty
            title="Selecione uma conversa"
            description="Escolha um atendimento do Instagram para visualizar o histórico."
          />
        ) : (
          <>
            <header className="thread-header">
              <div>
                <span>ATENDIMENTO PELO CRM</span>
                <h2>
                  {conversations.find((item) => item.id === selectedId)?.contact_name ??
                    'Contato Instagram'}
                </h2>
              </div>
              <button
                className="button outline compact"
                onClick={() => onOpenLead(thread.opportunity_id)}
              >
                Abrir ficha <ArrowRight size={15} />
              </button>
            </header>
            <div className="thread-messages" aria-live="polite">
              {thread.messages.map((message) => (
                <article
                  key={message.id}
                  className={`thread-message ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`}
                >
                  {message.text ? (
                    <p>{message.text}</p>
                  ) : !message.attachments?.length ? (
                    <p>Conteúdo {message.type}</p>
                  ) : null}
                  {!!message.attachments?.length && (
                    <div className="message-attachments">
                      {message.attachments.map((attachment, index) => (
                        <MediaAttachment
                          key={`${attachment.type}-${attachment.url ?? 'without-url'}-${index}`}
                          attachment={attachment}
                          downloadUrl={`/api/v1/conversations/${encodeURIComponent(selectedId)}/messages/${encodeURIComponent(message.id)}/attachments/${index}/download`}
                        />
                      ))}
                    </div>
                  )}
                  <small>
                    {time(message.created_at)}
                    {message.direction === 'outbound' ? ` · ${message.status}` : ''}
                  </small>
                </article>
              ))}
              {!thread.messages.length && <p className="muted">Nenhuma mensagem armazenada.</p>}
            </div>
            {thread.can_send ? (
              <form className="thread-composer" onSubmit={submit}>
                <textarea
                  value={draft}
                  onChange={(event) => {
                    setDraft(event.target.value);
                    if (sendCommand.current?.text !== event.target.value.trim())
                      sendCommand.current = null;
                  }}
                  maxLength={1000}
                  rows={2}
                  placeholder="Digite a resposta…"
                  aria-label="Mensagem para o Instagram"
                />
                <button className="button gold" disabled={!draft.trim() || sending || !connected}>
                  <Send size={17} />
                  {sending ? 'Enviando…' : 'Enviar'}
                </button>
              </form>
            ) : (
              <div className="thread-locked">
                <AlertTriangle size={18} />
                {user.role === 'manager'
                  ? 'A gestão pode acompanhar o histórico. A resposta pertence à atendente responsável.'
                  : 'Assuma o lead antes de responder pelo CRM.'}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
