import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Download,
  ExternalLink,
  FileQuestion,
  Inbox,
  Maximize2,
  MessageCircle,
  RefreshCw,
  Send,
  X,
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
  last_message_at: string;
  has_more: boolean;
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
const videoAttachmentTypes = new Set(['video']);
const sharedAttachmentTypes = new Set(['ig_post', 'ig_reel', 'post', 'reel', 'share']);
const sharedVideoTypes = new Set(['ig_reel', 'reel']);
const directMetaMediaHosts = ['cdninstagram.com', 'fbcdn.net', 'fbsbx.com'];

function directMetaMediaUrl(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (
      url.protocol === 'https:' &&
      directMetaMediaHosts.some(
        (trustedHost) => hostname === trustedHost || hostname.endsWith(`.${trustedHost}`),
      )
    )
      return url.href;
  } catch {
    return;
  }
}

function instagramEmbedUrl(value: string) {
  try {
    const url = new URL(value);
    if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return;
    const match = url.pathname.match(/^\/(p|reel|tv)\/([^/]+)/i);
    if (!match) return;
    return `https://www.instagram.com/${match[1].toLowerCase()}/${encodeURIComponent(match[2])}/embed/`;
  } catch {
    return;
  }
}

function InstagramEmbedPreview({ sourceUrl, label }: { sourceUrl: string; label: string }) {
  const embedUrl = instagramEmbedUrl(sourceUrl);
  if (!embedUrl) return null;
  return (
    <div className="instagram-embed-wrap">
      <iframe
        className="instagram-embed"
        src={embedUrl}
        title={`Prévia de ${label}`}
        loading="lazy"
        allow="autoplay; encrypted-media; picture-in-picture"
      />
      <a className="message-attachment-link" href={sourceUrl} target="_blank" rel="noreferrer">
        Abrir no Instagram
        <ExternalLink size={13} aria-hidden="true" />
      </a>
    </div>
  );
}

function cleanMessageUrl(value: string) {
  let url = value;
  let suffix = '';
  while (/[.,!?;:]$/.test(url)) {
    suffix = `${url.slice(-1)}${suffix}`;
    url = url.slice(0, -1);
  }
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    suffix = `)${suffix}`;
    url = url.slice(0, -1);
  }
  return { url, suffix };
}

function MessageText({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s]+)/g);
  const instagramUrl = parts.reduce<string | undefined>((found, part) => {
    if (found || !part.startsWith('http')) return found;
    const candidate = cleanMessageUrl(part).url;
    return instagramEmbedUrl(candidate) ? candidate : undefined;
  }, undefined);
  return (
    <>
      <p>
        {parts.map((part, index) => {
          if (!part.startsWith('http')) return part;
          const link = cleanMessageUrl(part);
          return (
            <span key={`${part}-${index}`}>
              <a href={link.url} target="_blank" rel="noreferrer">
                {link.url}
              </a>
              {link.suffix}
            </span>
          );
        })}
      </p>
      {instagramUrl && <InstagramEmbedPreview sourceUrl={instagramUrl} label="link do Instagram" />}
    </>
  );
}

function LazyVideo({ sourceUrl, onError }: { sourceUrl: string; onError: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || shouldLoad) return;
    if (!('IntersectionObserver' in window)) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [shouldLoad]);

  return (
    <video
      ref={videoRef}
      className="message-video"
      src={shouldLoad ? sourceUrl : undefined}
      controls
      playsInline
      preload={shouldLoad ? 'metadata' : 'none'}
      onError={onError}
    >
      Seu navegador não consegue reproduzir este vídeo.
    </video>
  );
}

function MediaAttachment({
  attachment,
  downloadUrl,
  previewUrl,
}: {
  attachment: ConversationMessage['attachments'][number];
  downloadUrl: string;
  previewUrl: string;
}) {
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const type = attachment.type.toLowerCase();
  const embedUrl = attachment.url ? instagramEmbedUrl(attachment.url) : undefined;
  const directUrl = embedUrl ? undefined : directMetaMediaUrl(attachment.url);
  const [useProxy, setUseProxy] = useState(!directUrl);
  const mediaUrl = useProxy || !directUrl ? previewUrl : directUrl;
  const sharedMedia = sharedAttachmentTypes.has(type) && !embedUrl;
  const sharedProbeRef = useRef<HTMLSpanElement>(null);
  const [shouldProbeSharedMedia, setShouldProbeSharedMedia] = useState(false);
  const [sharedKind, setSharedKind] = useState<'pending' | 'image' | 'video'>('pending');
  const [probeAttempt, setProbeAttempt] = useState(0);

  useEffect(() => {
    const node = sharedProbeRef.current;
    if (!sharedMedia || shouldProbeSharedMedia || !node) return;
    if (!('IntersectionObserver' in window)) {
      setShouldProbeSharedMedia(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldProbeSharedMedia(true);
        observer.disconnect();
      },
      { rootMargin: '320px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [sharedMedia, shouldProbeSharedMedia]);

  useEffect(() => {
    if (!sharedMedia || !shouldProbeSharedMedia) return;
    const controller = new AbortController();
    let response: Response | undefined;
    void fetch(previewUrl, {
      headers: { Range: 'bytes=0-0' },
      signal: controller.signal,
    })
      .then((result) => {
        response = result;
        if (!result.ok) throw new Error('media unavailable');
        const contentType = (result.headers.get('content-type') ?? '').toLowerCase();
        if (contentType.startsWith('image/')) setSharedKind('image');
        else if (contentType.startsWith('video/')) setSharedKind('video');
        else throw new Error('unsupported media');
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setFailed(true);
        void error;
      })
      .finally(() => void response?.body?.cancel().catch(() => {}));
    return () => controller.abort();
  }, [previewUrl, probeAttempt, sharedMedia, shouldProbeSharedMedia]);

  const retryMedia = () => {
    setFailed(false);
    setExpanded(false);
    setUseProxy(!directUrl);
    if (sharedMedia) {
      setSharedKind('pending');
      setShouldProbeSharedMedia(true);
      setProbeAttempt((current) => current + 1);
    }
  };

  const mediaFailed = () => {
    if (!useProxy && directUrl) {
      setUseProxy(true);
      return;
    }
    setFailed(true);
  };

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [expanded]);

  if (!attachment.url)
    return (
      <span className="message-media-unavailable" role="status">
        <FileQuestion size={16} aria-hidden="true" />
        Prévia não fornecida pelo Instagram
      </span>
    );

  if (failed)
    return (
      <span className="message-media-unavailable" role="status">
        <FileQuestion size={16} aria-hidden="true" />
        Mídia indisponível ou expirada
        <button type="button" onClick={retryMedia}>
          Tentar novamente
        </button>
        <a href={attachment.url} target="_blank" rel="noreferrer">
          Abrir original
        </a>
      </span>
    );

  if (embedUrl)
    return (
      <InstagramEmbedPreview
        sourceUrl={attachment.url}
        label={sharedVideoTypes.has(type) ? 'reel' : 'publicação'}
      />
    );

  if (sharedMedia && sharedKind === 'pending')
    return (
      <span ref={sharedProbeRef} className="message-media-unavailable" role="status">
        <RefreshCw size={16} aria-hidden="true" />
        Carregando prévia…
      </span>
    );

  if (imageAttachmentTypes.has(type) || (sharedAttachmentTypes.has(type) && sharedKind === 'image'))
    return (
      <div className="message-image-wrap">
        <button
          type="button"
          className="message-image-link"
          onClick={() => setExpanded(true)}
          aria-label="Abrir imagem em tamanho original"
        >
          <img
            className="message-image"
            src={mediaUrl}
            alt="Imagem recebida pelo Instagram"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={mediaFailed}
          />
          <span className="message-image-expand" aria-hidden="true">
            <Maximize2 size={15} />
          </span>
        </button>
        <a className="message-image-download" href={downloadUrl} download="imagem-instagram">
          <Download size={14} aria-hidden="true" />
          Baixar imagem
        </a>
        {expanded && (
          <div
            className="message-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Imagem ampliada"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setExpanded(false);
            }}
          >
            <button
              type="button"
              className="message-lightbox-close"
              onClick={() => setExpanded(false)}
              aria-label="Fechar imagem ampliada"
            >
              <X size={22} />
            </button>
            <img
              src={mediaUrl}
              alt="Imagem recebida pelo Instagram ampliada"
              referrerPolicy="no-referrer"
              onError={mediaFailed}
            />
            <a className="message-lightbox-download" href={downloadUrl} download="imagem-instagram">
              <Download size={16} aria-hidden="true" />
              Baixar imagem
            </a>
          </div>
        )}
      </div>
    );

  if (audioAttachmentTypes.has(type))
    return (
      <audio
        className="message-audio"
        src={mediaUrl}
        controls
        preload="none"
        onError={mediaFailed}
      >
        Seu navegador não consegue reproduzir este áudio.
      </audio>
    );

  if (videoAttachmentTypes.has(type) || (sharedAttachmentTypes.has(type) && sharedKind === 'video'))
    return (
      <div className="message-video-wrap">
        <LazyVideo sourceUrl={mediaUrl} onError={mediaFailed} />
        <a
          className="message-attachment-link"
          href={attachment.url}
          target="_blank"
          rel="noreferrer"
        >
          {sharedVideoTypes.has(type) ? 'Abrir reel no Instagram' : 'Abrir vídeo original'}
          <ExternalLink size={13} aria-hidden="true" />
        </a>
      </div>
    );

  return (
    <a className="message-attachment-link" href={attachment.url} target="_blank" rel="noreferrer">
      Abrir {sharedVideoTypes.has(type) ? 'reel no Instagram' : attachment.type}
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
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const sendCommand = useRef<{ text: string; key: string } | null>(null);
  const selectedIdRef = useRef('');
  const threadRef = useRef<ThreadResponse | null>(null);
  const loadedThreadVersion = useRef(new Map<string, string>());
  const listSequence = useRef(0);
  const threadSequence = useRef(0);
  const inboxRef = useRef<HTMLElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const stickToLatestMessage = useRef(true);
  const mobileThreadOpenRef = useRef(false);

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
    async (id: string, quiet = false, incremental = false) => {
      if (!id) return;
      const sequence = ++threadSequence.current;
      try {
        const current = threadRef.current;
        let append = Boolean(
          incremental && current?.conversation_id === id && current.messages.length,
        );
        let after = append ? current?.messages.at(-1)?.id : undefined;
        let result: ThreadResponse;
        const received: ConversationMessage[] = [];
        let pages = 0;
        try {
          do {
            const suffix = after ? `?after=${encodeURIComponent(after)}` : '';
            result = await api<ThreadResponse>(`/conversations/${id}/messages${suffix}`);
            received.push(...result.messages);
            after = result.messages.at(-1)?.id ?? after;
            pages += 1;
          } while (append && result.has_more && result.messages.length && pages < 10);
        } catch (error) {
          if (!(append && error instanceof ApiError && error.status === 400)) throw error;
          append = false;
          received.length = 0;
          result = await api<ThreadResponse>(`/conversations/${id}/messages`);
          received.push(...result.messages);
        }
        if (sequence !== threadSequence.current) return;
        const base = append && current?.conversation_id === id ? current.messages : [];
        const merged = new Map(base.map((message) => [message.id, message]));
        for (const message of received) merged.set(message.id, message);
        const next = {
          ...result!,
          messages: [...merged.values()].slice(-200),
        };
        const messageList = messageListRef.current;
        stickToLatestMessage.current =
          !append ||
          !messageList ||
          messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
        threadRef.current = next;
        setThread(next);
        loadedThreadVersion.current.set(
          id,
          append && result!.has_more ? '' : String(result!.last_message_at),
        );
        onConnectionChange(true);
        if (!append || received.some((message) => message.direction === 'inbound'))
          void api(`/conversations/${id}/read`, { method: 'POST', body: '{}' }).catch(() => {});
      } catch (error) {
        if (sequence !== threadSequence.current) return;
        if (!quiet) handleError(error);
      }
    },
    [handleError, onConnectionChange],
  );

  const refresh = useCallback(
    async (quiet = false, forceThread = false) => {
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
        const keepConversationSelected =
          !window.matchMedia('(max-width: 760px)').matches || mobileThreadOpenRef.current;
        const next = targeted
          ? targeted.id
          : keepConversationSelected
            ? result.conversations.some((item) => item.id === selectedIdRef.current)
              ? selectedIdRef.current
              : (result.conversations[0]?.id ?? '')
            : '';
        const previous = selectedIdRef.current;
        selectedIdRef.current = next;
        setSelectedId(next);
        if (targeted) {
          mobileThreadOpenRef.current = true;
          setMobileThreadOpen(true);
          onTargetConsumed();
        }
        if (next) {
          const summary = result.conversations.find((item) => item.id === next)!;
          const current = threadRef.current;
          const sameThread = current?.conversation_id === next;
          if (sameThread && current.can_send !== summary.can_send) {
            const updated = { ...current, can_send: summary.can_send };
            threadRef.current = updated;
            setThread(updated);
          }
          const version = String(summary.last_message_at);
          if (
            forceThread ||
            previous !== next ||
            !sameThread ||
            loadedThreadVersion.current.get(next) !== version
          )
            void loadThread(next, quiet, sameThread);
        } else {
          threadSequence.current += 1;
          threadRef.current = null;
          setThread(null);
          mobileThreadOpenRef.current = false;
          setMobileThreadOpen(false);
        }
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

  const latestMessageId = thread?.messages.at(-1)?.id;
  useEffect(() => {
    if (!thread || !stickToLatestMessage.current) return;
    const frame = window.requestAnimationFrame(() => {
      const messageList = messageListRef.current;
      if (messageList) messageList.scrollTop = messageList.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestMessageId, thread?.conversation_id]);

  useEffect(() => {
    if (loading) return;
    const inbox = inboxRef.current;
    const viewport = window.visualViewport;
    const mobile = window.matchMedia('(max-width: 760px)');
    if (!inbox) return;
    const resize = () => {
      if (!mobile.matches) {
        inbox.style.removeProperty('--inbox-mobile-height');
        return;
      }
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const top = Math.max(0, inbox.getBoundingClientRect().top);
      const navigationTop = document
        .querySelector<HTMLElement>('.mobile-bottom-nav')
        ?.getBoundingClientRect().top;
      const bottom =
        navigationTop && navigationTop > top && navigationTop < viewportHeight
          ? navigationTop
          : viewportHeight;
      inbox.style.setProperty('--inbox-mobile-height', `${Math.max(180, bottom - top)}px`);
    };
    const frame = window.requestAnimationFrame(() => {
      if (mobile.matches) inbox.scrollIntoView({ block: 'start' });
      resize();
    });
    viewport?.addEventListener('resize', resize);
    viewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    mobile.addEventListener('change', resize);
    return () => {
      window.cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', resize);
      viewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      mobile.removeEventListener('change', resize);
      inbox.style.removeProperty('--inbox-mobile-height');
    };
  }, [loading, mobileThreadOpen]);

  const select = (id: string) => {
    mobileThreadOpenRef.current = true;
    setMobileThreadOpen(true);
    selectedIdRef.current = id;
    setSelectedId(id);
    threadRef.current = null;
    setThread(null);
    void loadThread(id);
  };

  const returnToConversationList = () => {
    mobileThreadOpenRef.current = false;
    setMobileThreadOpen(false);
    selectedIdRef.current = '';
    setSelectedId('');
    threadSequence.current += 1;
    threadRef.current = null;
    setThread(null);
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
      await loadThread(selectedId, false, true);
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
    <section
      ref={inboxRef}
      className={`instagram-inbox${mobileThreadOpen ? ' mobile-thread-open' : ''}`}
      aria-label="Caixa de entrada do Instagram"
    >
      <aside className="inbox-list panel">
        <header>
          <div>
            <span>INSTAGRAM DIRECT</span>
            <h2>Conversas</h2>
          </div>
          <button
            className="icon-button"
            aria-label="Atualizar conversas"
            onClick={() => void refresh(false, true)}
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
              <div className="thread-heading">
                <button
                  type="button"
                  className="icon-button thread-back"
                  aria-label="Voltar para conversas"
                  onClick={returnToConversationList}
                >
                  <ArrowLeft size={20} />
                </button>
                <div>
                  <span>ATENDIMENTO PELO CRM</span>
                  <h2>
                    {conversations.find((item) => item.id === selectedId)?.contact_name ??
                      'Contato Instagram'}
                  </h2>
                </div>
              </div>
              <button
                className="button outline compact thread-lead-button"
                aria-label="Abrir ficha do lead"
                onClick={() => onOpenLead(thread.opportunity_id)}
              >
                <span>Abrir ficha</span> <ArrowRight size={15} />
              </button>
            </header>
            <div ref={messageListRef} className="thread-messages" aria-live="polite">
              {thread.messages.map((message) => (
                <article
                  key={message.id}
                  className={`thread-message ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`}
                >
                  {message.text ? (
                    <MessageText text={message.text} />
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
                          previewUrl={`/api/v1/conversations/${encodeURIComponent(selectedId)}/messages/${encodeURIComponent(message.id)}/attachments/${index}/media`}
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
