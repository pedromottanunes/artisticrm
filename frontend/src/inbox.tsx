import { LeadQualityControl, qualityReasons } from './lead-quality';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  BellOff,
  Download,
  ExternalLink,
  FileQuestion,
  Inbox,
  Maximize2,
  MessageCircle,
  RefreshCw,
  Send,
  X,
  Zap,
} from 'lucide-react';
import {
  api,
  ApiError,
  type MessageShortcut,
  type ConversationMessage,
  type ConversationSummary,
  type User,
} from './api';
import { Empty } from './components';
import { signalWithTimeout } from './abort';

interface ListResponse {
  revision?: string;
  configured: boolean;
  conversations: ConversationSummary[];
  has_more?: boolean;
  next_before_at?: string | null;
  next_before_id?: string | null;
  review_source_ids?: string[];
  target_conversation?: ConversationSummary | null;
}

interface ThreadResponse {
  conversation_id: string;
  opportunity_id: string;
  can_send: boolean;
  messaging_mode?: ConversationSummary['messaging_mode'];
  last_message_at: string;
  has_more: boolean;
  has_older?: boolean;
  messages: ConversationMessage[];
}

const time = (value: string) =>
  new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));

const compareConversations = (left: ConversationSummary, right: ConversationSummary) => {
  const timeDifference =
    new Date(right.last_message_at).getTime() - new Date(left.last_message_at).getTime();
  if (timeDifference) return timeDifference;
  return left.id === right.id ? 0 : left.id < right.id ? -1 : 1;
};

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
    const probe = async (url: string) => {
      const request = signalWithTimeout(controller.signal, 10_000);
      try {
        const result = await fetch(url, {
          headers: { Range: 'bytes=0-0' },
          credentials: url === previewUrl ? 'same-origin' : 'omit',
          referrerPolicy: 'no-referrer',
          signal: request.signal,
        });
        try {
          if (!result.ok) throw new Error('media unavailable');
          const contentType = (result.headers.get('content-type') ?? '').toLowerCase();
          if (contentType.startsWith('image/')) return 'image' as const;
          if (contentType.startsWith('video/')) return 'video' as const;
          throw new Error('unsupported media');
        } finally {
          // Even when the CDN ignores Range, do not download the entire file to identify it.
          await result.body?.cancel().catch(() => {});
        }
      } finally {
        request.dispose();
      }
    };
    void (async () => {
      try {
        let kind: 'image' | 'video';
        try {
          kind = await probe(directUrl ?? previewUrl);
        } catch (error) {
          if (!directUrl || controller.signal.aborted) throw error;
          // Some CDN URLs cannot be fetched with CORS, but still play directly.
          kind = await probe(previewUrl);
        }
        if (!controller.signal.aborted) setSharedKind(kind);
      } catch {
        if (!controller.signal.aborted) setFailed(true);
      }
    })();
    return () => controller.abort();
  }, [directUrl, previewUrl, probeAttempt, sharedMedia, shouldProbeSharedMedia]);

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
        Prévia não fornecida pelo canal
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
            alt="Imagem recebida na conversa"
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={mediaFailed}
          />
          <span className="message-image-expand" aria-hidden="true">
            <Maximize2 size={15} />
          </span>
        </button>
        <a className="message-image-download" href={downloadUrl} download="imagem-conversa">
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
              alt="Imagem recebida na conversa ampliada"
              referrerPolicy="no-referrer"
              onError={mediaFailed}
            />
            <a className="message-lightbox-download" href={downloadUrl} download="imagem-conversa">
              <Download size={16} aria-hidden="true" />
              Baixar imagem
            </a>
          </div>
        )}
      </div>
    );

  if (audioAttachmentTypes.has(type))
    return (
      <audio className="message-audio" src={mediaUrl} controls preload="none" onError={mediaFailed}>
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
  users,
  connected,
  targetOpportunityId,
  targetArchived,
  onTargetConsumed,
  onOpenLead,
  onNotice,
  onConnectionChange,
  onSessionExpired,
}: {
  user: User;
  users: User[];
  connected: boolean;
  targetOpportunityId: string;
  targetArchived: boolean;
  onTargetConsumed: () => void;
  onOpenLead: (id: string) => void;
  onNotice: (message: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onSessionExpired: () => void;
}) {
  const [archive, setArchive] = useState(targetArchived);
  const [review, setReview] = useState(false);
  const [ownerFilter, setOwnerFilter] = useState('');
  const [managerPages, setManagerPages] = useState<Array<{ at: string; id: string }>>([]);
  const [managerListChanging, setManagerListChanging] = useState(false);
  const [configured, setConfigured] = useState(true);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [mobileThreadOpen, setMobileThreadOpen] = useState(false);
  const [thread, setThread] = useState<ThreadResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [assuming, setAssuming] = useState(false);
  const [listLoadingMore, setListLoadingMore] = useState(false);
  const [listHasMore, setListHasMore] = useState(false);
  const [olderMessagesLoading, setOlderMessagesLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draft = drafts[selectedId] ?? '';
  const [shortcutPickerOpen, setShortcutPickerOpen] = useState(false);
  const [shortcutsLoading, setShortcutsLoading] = useState(false);
  const [shortcuts, setShortcuts] = useState<MessageShortcut[]>([]);
  const pendingSends = useRef(new Map<string, string>());
  const assumeReceipt = useRef<{ opportunityId: string; key: string } | null>(null);
  const sendingRef = useRef(false);
  const notificationSavingRef = useRef(false);
  const mounted = useRef(true);
  const shortcutRequest = useRef<AbortController | null>(null);
  const selectedIdRef = useRef('');
  const threadRef = useRef<ThreadResponse | null>(null);
  const loadedThreadVersion = useRef(new Map<string, string>());
  const listSequence = useRef(0);
  const threadSequence = useRef(0);
  const threadLoadedAt = useRef(0);
  const listRequest = useRef<AbortController | null>(null);
  const threadRequest = useRef<{ id: string; controller: AbortController } | null>(null);
  const listCache = useRef<ListResponse | null>(null);
  const listCacheScope = useRef('');
  const managerTarget = useRef('');
  const preventAutoSelection = useRef(false);
  const conversationsRef = useRef<ConversationSummary[]>([]);
  const listPagination = useRef({
    scope: '',
    loadedBeyondFirst: false,
    hasMore: false,
    beforeAt: null as string | null,
    beforeId: null as string | null,
  });
  const retryAfter = useRef(0);
  const pollFailures = useRef(0);
  const inboxRef = useRef<HTMLElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const stickToLatestMessage = useRef(true);
  const mobileThreadOpenRef = useRef(false);
  const shortcutPickerRef = useRef<HTMLDivElement>(null);
  const shortcutTriggerRef = useRef<HTMLButtonElement>(null);

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

  const markConversationRead = useCallback(async (id: string, lastMessageId?: string) => {
    if (!lastMessageId) return;
    try {
      await api(`/conversations/${id}/read`, {
        method: 'POST',
        body: JSON.stringify({ last_message_id: lastMessageId }),
      });
      if (!mounted.current) return;
      const clearUnread = (items: ConversationSummary[]) =>
        items.map((item) => (item.id === id && item.unread ? { ...item, unread: false } : item));
      setConversations(clearUnread);
      conversationsRef.current = clearUnread(conversationsRef.current);
      // Keep the cached server snapshot untouched. If a newer message arrived
      // during this request, the next poll restores its unread state.
    } catch {
      // The next poll restores the server state; reading a chat must stay non-blocking.
    }
  }, []);

  const openShortcutPicker = async () => {
    if (shortcutPickerOpen) {
      setShortcutPickerOpen(false);
      return;
    }
    if (!connected || sendingRef.current) return;
    setShortcutPickerOpen(true);
    shortcutRequest.current?.abort();
    const controller = new AbortController();
    shortcutRequest.current = controller;
    setShortcutsLoading(true);
    try {
      const result = await api<{ shortcuts: MessageShortcut[] }>('/shortcuts', {
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setShortcuts(result.shortcuts);
      onConnectionChange(true);
    } catch (error) {
      if (controller.signal.aborted) return;
      handleError(error);
      setShortcutPickerOpen(false);
    } finally {
      if (!controller.signal.aborted) setShortcutsLoading(false);
    }
  };

  useEffect(() => {
    setShortcutPickerOpen(false);
  }, [selectedId, thread?.can_send]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      shortcutRequest.current?.abort();
      listRequest.current?.abort();
      listRequest.current = null;
      threadRequest.current?.controller.abort();
      threadRequest.current = null;
      selectedIdRef.current = '';
      threadSequence.current += 1;
      listSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!shortcutPickerOpen) return;
    const close = (event: PointerEvent) => {
      if (!shortcutPickerRef.current?.contains(event.target as Node)) setShortcutPickerOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShortcutPickerOpen(false);
        shortcutTriggerRef.current?.focus();
      }
    };
    const composer = shortcutPickerRef.current?.closest<HTMLElement>('.thread-composer');
    const resize = () => {
      if (!composer) return;
      const viewportTop = window.visualViewport?.offsetTop ?? 0;
      const headerBottom =
        composer.closest('.inbox-thread')?.querySelector('.thread-header')?.getBoundingClientRect()
          .bottom ?? 0;
      const available = Math.max(
        60,
        composer.getBoundingClientRect().top - Math.max(viewportTop, headerBottom) - 12,
      );
      composer.style.setProperty('--shortcut-menu-height', `${available}px`);
    };
    resize();
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    window.addEventListener('resize', resize);
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', escape);
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
      window.removeEventListener('resize', resize);
      shortcutRequest.current?.abort();
    };
  }, [shortcutPickerOpen]);

  const loadThread = useCallback(
    async (id: string, quiet = false, incremental = false) => {
      if (!mounted.current || !id || selectedIdRef.current !== id) return;
      if (quiet && threadRequest.current?.id === id) return;
      threadRequest.current?.controller.abort();
      const controller = new AbortController();
      threadRequest.current = { id, controller };
      const request = signalWithTimeout(controller.signal, 20_000);
      const signal = request.signal;
      const sequence = ++threadSequence.current;
      try {
        const current = threadRef.current;
        let append = Boolean(
          incremental &&
          current?.conversation_id === id &&
          current.messages.length &&
          !current.messages.some(
            (message) =>
              message.direction === 'outbound' && ['sending', 'queued'].includes(message.status),
          ),
        );
        let after = append ? current?.messages.at(-1)?.id : undefined;
        let result: ThreadResponse;
        const received: ConversationMessage[] = [];
        let pages = 0;
        try {
          do {
            const suffix = after ? `?after=${encodeURIComponent(after)}` : '';
            result = await api<ThreadResponse>(`/conversations/${id}/messages${suffix}`, {
              signal,
            });
            received.push(...result.messages);
            after = result.messages.at(-1)?.id ?? after;
            pages += 1;
          } while (append && result.has_more && result.messages.length && pages < 2);
          // After a long absence only the latest visible window is useful.
          if (append && result.has_more) {
            append = false;
            received.length = 0;
            result = await api<ThreadResponse>(`/conversations/${id}/messages`, { signal });
            received.push(...result.messages);
          }
        } catch (error) {
          if (!(append && error instanceof ApiError && error.status === 400)) throw error;
          append = false;
          received.length = 0;
          result = await api<ThreadResponse>(`/conversations/${id}/messages`, { signal });
          received.push(...result.messages);
        }
        if (signal.aborted || sequence !== threadSequence.current || selectedIdRef.current !== id)
          return;
        const base = append && current?.conversation_id === id ? current.messages : [];
        const merged = new Map(base.map((message) => [message.id, message]));
        for (const message of received) merged.set(message.id, message);
        const next = {
          ...result!,
          has_older: append ? current?.has_older : result!.has_older,
          messages: [...merged.values()],
        };
        const messageList = messageListRef.current;
        stickToLatestMessage.current =
          current?.conversation_id !== id ||
          !messageList ||
          messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 120;
        threadRef.current = next;
        threadLoadedAt.current = Date.now();
        setThread(next);
        loadedThreadVersion.current.set(
          id,
          append && result!.has_more ? '' : String(result!.last_message_at),
        );
        onConnectionChange(true);
        if (
          current?.conversation_id !== id ||
          (current.messages.at(-1)?.id !== next.messages.at(-1)?.id &&
            received.some((message) => message.direction === 'inbound'))
        )
          void markConversationRead(id, next.messages.at(-1)?.id);
      } catch (error) {
        if (
          controller.signal.aborted ||
          sequence !== threadSequence.current ||
          selectedIdRef.current !== id
        )
          return;
        onConnectionChange(false);
        if (!quiet || (error instanceof ApiError && error.status === 401)) handleError(error);
      } finally {
        request.dispose();
        if (threadRequest.current?.controller === controller) threadRequest.current = null;
      }
    },
    [handleError, markConversationRead, onConnectionChange],
  );

  const loadOlderMessages = useCallback(async () => {
    const current = threadRef.current;
    const id = selectedIdRef.current;
    const firstMessageId = current?.messages[0]?.id;
    if (!current?.has_older || !id || !firstMessageId || olderMessagesLoading) return;
    setOlderMessagesLoading(true);
    const messageList = messageListRef.current;
    const previousHeight = messageList?.scrollHeight ?? 0;
    try {
      const result = await api<ThreadResponse>(
        `/conversations/${id}/messages?before=${encodeURIComponent(firstMessageId)}`,
      );
      if (!mounted.current || selectedIdRef.current !== id) return;
      const latest = threadRef.current;
      if (!latest || latest.conversation_id !== id) return;
      const merged = new Map(result.messages.map((message) => [message.id, message]));
      for (const message of latest.messages) merged.set(message.id, message);
      const next = {
        ...latest,
        has_older: result.has_older,
        messages: [...merged.values()],
      };
      threadRef.current = next;
      setThread(next);
      requestAnimationFrame(() => {
        const list = messageListRef.current;
        if (list) list.scrollTop += list.scrollHeight - previousHeight;
      });
      onConnectionChange(true);
    } catch (error) {
      handleError(error);
    } finally {
      if (mounted.current) setOlderMessagesLoading(false);
    }
  }, [handleError, olderMessagesLoading, onConnectionChange]);

  const refresh = useCallback(
    async (quiet = false, forceThread = false) => {
      if (!mounted.current || notificationSavingRef.current) return;
      if (quiet && (listRequest.current || Date.now() < retryAfter.current)) return;
      listRequest.current?.abort();
      const controller = new AbortController();
      listRequest.current = controller;
      const request = signalWithTimeout(controller.signal, 20_000);
      const sequence = ++listSequence.current;
      try {
        const requestedTarget =
          user.role === 'manager' ? targetOpportunityId || managerTarget.current : '';
        const view =
          user.role === 'manager' && targetOpportunityId
            ? targetArchived
              ? 'non_commercial'
              : 'all'
            : review
              ? 'review'
              : archive
                ? 'non_commercial'
                : user.role === 'manager'
                  ? 'all'
                  : 'mine';
        const params = new URLSearchParams({ view });
        if (user.role === 'manager') {
          // A new external target starts from the first page, independently of the
          // previous filter. Manual navigation consumes it and resumes normal paging.
          if (!targetOpportunityId) {
            if (ownerFilter) params.set('owner_id', ownerFilter);
            const cursor = managerPages.at(-1);
            if (cursor) {
              params.set('before_at', cursor.at);
              params.set('before_id', cursor.id);
            }
          }
          if (requestedTarget) params.set('target_opportunity_id', requestedTarget);
        }
        const requestScope = params.toString();
        // Revisions belong to one filter/page, never to the previously selected consultant.
        const revision =
          listCacheScope.current === requestScope ? listCache.current?.revision : undefined;
        if (revision) params.set('revision', revision);
        const response = await api<ListResponse | { unchanged: true; revision: string }>(
          `/conversations?${params.toString()}`,
          {
            signal: request.signal,
          },
        );
        if (sequence !== listSequence.current) return;
        const result = 'unchanged' in response ? listCache.current : response;
        if (!result) return;
        listCache.current = result;
        listCacheScope.current = requestScope;
        pollFailures.current = 0;
        retryAfter.current = 0;
        setConfigured(result.configured);
        const scope = `${view}:${[...(result.review_source_ids ?? [])].sort().join('|')}`;
        const previousPagination = listPagination.current;
        const preserveLoadedPages =
          review &&
          result.conversations.length > 0 &&
          previousPagination.loadedBeyondFirst &&
          previousPagination.scope === scope;
        const allowedReviewOwners = new Set(result.review_source_ids ?? []);
        const pageConversations = preserveLoadedPages
          ? [
              ...new Map(
                [
                  ...result.conversations,
                  ...conversationsRef.current.filter(
                    (conversation) =>
                      !conversation.review_shared ||
                      allowedReviewOwners.has(conversation.owner_id ?? ''),
                  ),
                ].map((conversation) => [conversation.id, conversation]),
              ).values(),
            ].sort(compareConversations)
          : result.conversations;
        const directTarget = requestedTarget
          ? (pageConversations.find((item) => item.opportunity_id === requestedTarget) ??
            (result.target_conversation?.opportunity_id === requestedTarget
              ? result.target_conversation
              : undefined))
          : undefined;
        const nextConversations =
          directTarget && !pageConversations.some((item) => item.id === directTarget.id)
            ? [directTarget, ...pageConversations]
            : pageConversations;
        if (requestedTarget) {
          managerTarget.current = directTarget ? requestedTarget : '';
          if (
            !directTarget &&
            (targetOpportunityId ||
              conversationsRef.current.some(
                (item) =>
                  item.id === selectedIdRef.current && item.opportunity_id === requestedTarget,
              ))
          ) {
            // A missing/deleted/recategorized target must not silently open another lead.
            preventAutoSelection.current = true;
            onNotice(
              'A conversa solicitada não está disponível nesta categoria. Selecione outra conversa.',
            );
          }
        }
        conversationsRef.current = nextConversations;
        setConversations(nextConversations);
        if (!preserveLoadedPages) {
          listPagination.current = {
            scope,
            loadedBeyondFirst: false,
            hasMore: Boolean(result.has_more),
            beforeAt: result.next_before_at ?? null,
            beforeId: result.next_before_id ?? null,
          };
        }
        setListHasMore(listPagination.current.hasMore);
        const targeted = targetOpportunityId
          ? nextConversations.find((item) => item.opportunity_id === targetOpportunityId)
          : undefined;
        const keepConversationSelected =
          !preventAutoSelection.current &&
          (!window.matchMedia('(max-width: 760px)').matches || mobileThreadOpenRef.current);
        const next = targeted
          ? targeted.id
          : keepConversationSelected
            ? nextConversations.some((item) => item.id === selectedIdRef.current)
              ? selectedIdRef.current
              : (nextConversations[0]?.id ?? '')
            : '';
        const previous = selectedIdRef.current;
        selectedIdRef.current = next;
        setSelectedId(next);
        if (previous !== next) {
          threadRequest.current?.controller.abort();
          threadRequest.current = null;
          threadSequence.current += 1;
          threadRef.current = null;
          setThread(null);
        }
        if (targeted) {
          mobileThreadOpenRef.current = true;
          setMobileThreadOpen(true);
          onTargetConsumed();
        } else if (requestedTarget && targetOpportunityId) {
          onTargetConsumed();
        }
        if (next) {
          const summary = nextConversations.find((item) => item.id === next)!;
          const current = threadRef.current;
          const sameThread = current?.conversation_id === next;
          if (
            sameThread &&
            (current.can_send !== summary.can_send ||
              current.messaging_mode !== summary.messaging_mode)
          ) {
            const updated = {
              ...current,
              can_send: summary.can_send,
              messaging_mode: summary.messaging_mode,
            };
            threadRef.current = updated;
            setThread(updated);
          }
          const version = String(summary.last_message_at);
          // A pending send can change status without adding a new message. Refresh
          // only that exceptional case, and less frequently than the list.
          const pendingStatus =
            sameThread &&
            current.messages.some(
              (message) =>
                message.direction === 'outbound' && ['sending', 'queued'].includes(message.status),
            );
          if (
            forceThread ||
            previous !== next ||
            !sameThread ||
            loadedThreadVersion.current.get(next) !== version ||
            (pendingStatus && Date.now() - threadLoadedAt.current >= 15_000)
          )
            void loadThread(next, quiet, sameThread && !forceThread);
        } else {
          threadRequest.current?.controller.abort();
          threadRequest.current = null;
          threadSequence.current += 1;
          threadRef.current = null;
          setThread(null);
          mobileThreadOpenRef.current = false;
          setMobileThreadOpen(false);
        }
        onConnectionChange(true);
      } catch (error) {
        if (controller.signal.aborted || sequence !== listSequence.current) return;
        retryAfter.current =
          Date.now() + Math.min(30_000, 5000 * 2 ** Math.min(++pollFailures.current, 3));
        onConnectionChange(false);
        if (!quiet || (error instanceof ApiError && error.status === 401)) handleError(error);
      } finally {
        request.dispose();
        if (listRequest.current === controller) listRequest.current = null;
        if (sequence === listSequence.current) {
          setLoading(false);
          setManagerListChanging(false);
        }
      }
    },
    [
      archive,
      review,
      handleError,
      loadThread,
      onConnectionChange,
      onTargetConsumed,
      targetOpportunityId,
      targetArchived,
      onNotice,
      user.role,
      ownerFilter,
      managerPages,
    ],
  );

  const loadMoreConversations = useCallback(async () => {
    const page = listPagination.current;
    if (!review || listLoadingMore || !page.hasMore || !page.beforeAt || !page.beforeId) return;
    const expectedScope = page.scope;
    setListLoadingMore(true);
    try {
      const params = new URLSearchParams({
        view: 'review',
        before_at: page.beforeAt,
        before_id: page.beforeId,
      });
      const result = await api<ListResponse>(`/conversations?${params.toString()}`);
      const resultScope = `review:${[...(result.review_source_ids ?? [])].sort().join('|')}`;
      if (!mounted.current || listPagination.current.scope !== expectedScope) return;
      if (resultScope !== expectedScope) {
        listCache.current = null;
        listPagination.current = {
          scope: '',
          loadedBeyondFirst: false,
          hasMore: false,
          beforeAt: null,
          beforeId: null,
        };
        await refresh();
        return;
      }
      const merged = [
        ...new Map(
          [...conversationsRef.current, ...result.conversations].map((conversation) => [
            conversation.id,
            conversation,
          ]),
        ).values(),
      ].sort(compareConversations);
      conversationsRef.current = merged;
      setConversations(merged);
      listPagination.current = {
        scope: expectedScope,
        loadedBeyondFirst: true,
        hasMore: Boolean(result.has_more),
        beforeAt: result.next_before_at ?? null,
        beforeId: result.next_before_id ?? null,
      };
      setListHasMore(Boolean(result.has_more));
      onConnectionChange(true);
    } catch (error) {
      handleError(error);
    } finally {
      if (mounted.current) setListLoadingMore(false);
    }
  }, [handleError, listLoadingMore, onConnectionChange, refresh, review]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    if (!targetOpportunityId) return;
    listCache.current = null;
    listPagination.current = {
      scope: '',
      loadedBeyondFirst: false,
      hasMore: false,
      beforeAt: null,
      beforeId: null,
    };
    setListHasMore(false);
    setArchive(targetArchived);
    setReview(false);
    if (user.role === 'manager') {
      managerTarget.current = targetOpportunityId;
      preventAutoSelection.current = false;
      setOwnerFilter('');
      setManagerPages((pages) => (pages.length ? [] : pages));
    }
  }, [targetArchived, targetOpportunityId, user.role]);

  useEffect(() => {
    const changed = () => {
      listCache.current = null;
      loadedThreadVersion.current.clear();
      void refresh(false, true);
    };
    window.addEventListener('artisti-lead-quality', changed);
    return () => window.removeEventListener('artisti-lead-quality', changed);
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
    preventAutoSelection.current = false;
    if (user.role === 'manager' && targetOpportunityId) onTargetConsumed();
    setShortcutPickerOpen(false);
    mobileThreadOpenRef.current = true;
    setMobileThreadOpen(true);
    selectedIdRef.current = id;
    setSelectedId(id);
    threadRef.current = null;
    setThread(null);
    void loadThread(id);
  };

  const returnToConversationList = () => {
    threadRequest.current?.controller.abort();
    threadRequest.current = null;
    setShortcutPickerOpen(false);
    mobileThreadOpenRef.current = false;
    setMobileThreadOpen(false);
    selectedIdRef.current = '';
    setSelectedId('');
    threadSequence.current += 1;
    threadRef.current = null;
    setThread(null);
  };

  const sendText = async (value: string, clearDraft: boolean) => {
    const text = value.trim();
    const conversationId = selectedId;
    if (
      !text ||
      !conversationId ||
      selectedIdRef.current !== conversationId ||
      threadRef.current?.conversation_id !== conversationId ||
      !threadRef.current.can_send ||
      sendingRef.current ||
      !connected
    )
      return;
    // Keep the retry key for this exact recipient and text until its outcome is known.
    const commandId = JSON.stringify([conversationId, text]);
    const key = pendingSends.current.get(commandId) ?? crypto.randomUUID();
    pendingSends.current.set(commandId, key);
    sendingRef.current = true;
    setShortcutPickerOpen(false);
    setSending(true);
    try {
      const result = await api<{ status: string }>(`/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: JSON.stringify({ text }),
      });
      if (!mounted.current) return;
      if (['sent', 'delivered', 'read'].includes(result.status)) {
        pendingSends.current.delete(commandId);
        if (clearDraft)
          setDrafts((current) =>
            current[conversationId]?.trim() === text
              ? { ...current, [conversationId]: '' }
              : current,
          );
      } else if (result.status === 'failed') {
        pendingSends.current.delete(commandId);
        onNotice(
          `O ${selectedConversation?.channel === 'messenger' ? 'Messenger' : 'Instagram'} recusou a mensagem. Você pode tentar novamente.`,
        );
      } else
        onNotice(
          'O envio ainda não foi confirmado pela Meta. Confira a conversa antes de tentar novamente.',
        );
      if (selectedIdRef.current === conversationId) await loadThread(conversationId, false, true);
      await refresh(true);
    } catch (error) {
      if (
        error instanceof ApiError &&
        (error.status < 500 ||
          error.code === 'INSTAGRAM_SEND_FAILED' ||
          error.code === 'MESSENGER_SEND_FAILED')
      )
        pendingSends.current.delete(commandId);
      if (mounted.current) handleError(error);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendText(draft, true);
  };

  const selectedConversation = conversations.find((item) => item.id === selectedId);
  const consultants = users
    .filter((item) => item.role === 'attendant')
    .sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'));
  const ownerLabel = (conversation: ConversationSummary) => {
    if (!conversation.owner_id) return 'Sem consultor responsável';
    return (
      users.find((item) => item.id === conversation.owner_id)?.name ?? 'Consultor indisponível'
    );
  };
  const clearManagerList = () => {
    managerTarget.current = '';
    preventAutoSelection.current = false;
    if (targetOpportunityId) onTargetConsumed();
    listRequest.current?.abort();
    listRequest.current = null;
    listSequence.current += 1;
    listCache.current = null;
    retryAfter.current = 0;
    returnToConversationList();
    conversationsRef.current = [];
    setConversations([]);
    setListHasMore(false);
    setManagerListChanging(true);
  };
  const resetConversationPagination = () => {
    if (user.role === 'manager') {
      clearManagerList();
      setManagerPages([]);
    }
    listPagination.current = {
      scope: '',
      loadedBeyondFirst: false,
      hasMore: false,
      beforeAt: null,
      beforeId: null,
    };
    setListHasMore(false);
  };
  const canControlNotifications =
    user.role === 'attendant' &&
    selectedConversation?.owner_id === user.id &&
    !selectedConversation?.non_commercial_reason;
  const assumeConversation = async () => {
    if (!selectedConversation?.review_shared || assuming || !connected) return;
    setAssuming(true);
    const opportunityId = selectedConversation.opportunity_id;
    if (assumeReceipt.current?.opportunityId !== opportunityId)
      assumeReceipt.current = { opportunityId, key: crypto.randomUUID() };
    try {
      await api(`/opportunities/${opportunityId}/assume-shared-conversation`, {
        method: 'POST',
        body: JSON.stringify({ expected_version: selectedConversation.version }),
        headers: { 'Idempotency-Key': assumeReceipt.current.key },
      });
      assumeReceipt.current = null;
      listCache.current = null;
      loadedThreadVersion.current.clear();
      selectedIdRef.current = '';
      threadRef.current = null;
      setSelectedId('');
      setThread(null);
      conversationsRef.current = [];
      setConversations([]);
      listPagination.current = {
        scope: '',
        loadedBeyondFirst: false,
        hasMore: false,
        beforeAt: null,
        beforeId: null,
      };
      setListHasMore(false);
      setReview(false);
      setArchive(false);
      onNotice('Conversa assumida. Ela agora está em seus atendimentos.');
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) assumeReceipt.current = null;
      handleError(error);
    } finally {
      if (mounted.current) setAssuming(false);
    }
  };
  const toggleNotifications = async () => {
    const conversation = conversations.find((item) => item.id === selectedIdRef.current);
    if (
      !conversation ||
      user.role !== 'attendant' ||
      conversation.owner_id !== user.id ||
      notificationSavingRef.current ||
      !connected
    )
      return;
    const muted = !conversation.notifications_muted;
    notificationSavingRef.current = true;
    listRequest.current?.abort();
    listRequest.current = null;
    listSequence.current += 1;
    setNotificationSaving(true);
    try {
      const result = await api<{ notifications_muted: boolean }>(
        `/conversations/${encodeURIComponent(conversation.id)}/notifications`,
        { method: 'PUT', body: JSON.stringify({ muted }) },
      );
      if (!mounted.current) return;
      const update = (items: ConversationSummary[]) =>
        items.map((item) =>
          item.id === conversation.id
            ? { ...item, notifications_muted: result.notifications_muted }
            : item,
        );
      setConversations(update);
      conversationsRef.current = update(conversationsRef.current);
      if (listCache.current)
        listCache.current = {
          ...listCache.current,
          revision: undefined,
          conversations: update(listCache.current.conversations),
        };
      onConnectionChange(true);
      onNotice(
        result.notifications_muted
          ? 'Notificações deste lead silenciadas.'
          : 'Notificações deste lead reativadas.',
      );
    } catch (error) {
      if (mounted.current) handleError(error);
    } finally {
      notificationSavingRef.current = false;
      if (mounted.current) {
        setNotificationSaving(false);
        void refresh(true);
      }
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
          title="Canais de conversa ainda não conectados"
          description="Configure uma integração e publique o webhook para receber conversas aqui."
        />
      </section>
    );

  return (
    <section
      ref={inboxRef}
      className={`instagram-inbox${user.role === 'manager' ? ' manager-inbox' : ''}${mobileThreadOpen ? ' mobile-thread-open' : ''}`}
      aria-label="Caixa de entrada multicanal"
    >
      <aside className="inbox-list panel">
        <header>
          <div>
            <span>CAIXA MULTICANAL</span>
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
        {user.role === 'manager' && (
          <div className="inbox-owner-filter">
            <label htmlFor="inbox-consultant">Consultor responsável</label>
            <select
              id="inbox-consultant"
              value={ownerFilter}
              onChange={(event) => {
                clearManagerList();
                setManagerPages([]);
                setOwnerFilter(event.target.value);
              }}
            >
              <option value="">Todos os consultores</option>
              <option value="unassigned">Sem consultor responsável</option>
              {[true, false].map((active) => (
                <optgroup
                  key={String(active)}
                  label={active ? 'Consultores ativos' : 'Consultores desativados'}
                >
                  {consultants
                    .filter((item) => (item.active && item.queue_enabled) === active)
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
        <div className="quality-tabs" role="group" aria-label="Tipo de atendimento">
          <button
            type="button"
            aria-pressed={!archive && !review}
            onClick={() => {
              listCache.current = null;
              resetConversationPagination();
              setArchive(false);
              setReview(false);
            }}
          >
            Ativos
          </button>
          <button
            type="button"
            aria-pressed={archive}
            onClick={() => {
              listCache.current = null;
              resetConversationPagination();
              setArchive(true);
              setReview(false);
            }}
          >
            Não comerciais
          </button>
          {user.role === 'attendant' && (
            <button
              type="button"
              aria-pressed={review}
              onClick={() => {
                listCache.current = null;
                resetConversationPagination();
                setArchive(false);
                setReview(true);
              }}
            >
              Para revisar
            </button>
          )}
        </div>
        <div className="inbox-conversations" aria-busy={managerListChanging}>
          {conversations.map((conversation) => (
            <button
              key={conversation.id}
              className={`${selectedId === conversation.id ? 'active' : ''}${conversation.unread ? ' unread' : ''}`.trim()}
              onClick={() => select(conversation.id)}
              aria-label={`${conversation.contact_name}${conversation.unread ? ', nova mensagem' : ''}${conversation.notifications_muted ? ', notificações silenciadas' : ''}`}
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
                  {conversation.channel === 'messenger'
                    ? 'Facebook Messenger'
                    : conversation.instagram_username
                      ? `@${conversation.instagram_username}`
                      : 'Instagram Direct'}
                </small>
                {user.role === 'manager' && (
                  <small className="inbox-conversation-owner" title={ownerLabel(conversation)}>
                    {ownerLabel(conversation)}
                  </small>
                )}
              </span>
              <time>{time(conversation.last_message_at)}</time>
            </button>
          ))}
          {review && listHasMore && (
            <button
              type="button"
              className="inbox-load-more"
              disabled={listLoadingMore}
              onClick={() => void loadMoreConversations()}
            >
              {listLoadingMore ? 'Carregandoâ€¦' : 'Carregar conversas anteriores'}
            </button>
          )}
          {managerListChanging && (
            <div className="inbox-empty-list" role="status">
              Carregando conversas…
            </div>
          )}
          {!managerListChanging && !conversations.length && (
            <div className="inbox-empty-list">
              <Inbox size={27} />
              <strong>Nenhuma conversa</strong>
              <span>
                {user.role === 'manager'
                  ? ownerFilter
                    ? 'Nenhuma conversa deste responsável nesta categoria.'
                    : 'As novas mensagens do Instagram e Messenger aparecerão aqui.'
                  : review
                    ? 'A gestão ainda não compartilhou uma carteira com você.'
                    : 'Depois de assumir um lead, a conversa aparecerá aqui.'}
              </span>
            </div>
          )}
        </div>
        {user.role === 'manager' && (managerPages.length > 0 || listHasMore) && (
          <nav className="inbox-list-pagination" aria-label="Páginas de conversas">
            <button
              type="button"
              className="button outline compact"
              disabled={managerListChanging || managerPages.length === 0}
              onClick={() => {
                clearManagerList();
                setManagerPages((pages) => pages.slice(0, -1));
              }}
            >
              Mais recentes
            </button>
            <span>Página {managerPages.length + 1}</span>
            <button
              type="button"
              className="button outline compact"
              disabled={managerListChanging || !listHasMore}
              onClick={() => {
                const { beforeAt, beforeId } = listPagination.current;
                if (!beforeAt || !beforeId) return;
                clearManagerList();
                setManagerPages((pages) => [...pages, { at: beforeAt, id: beforeId }]);
              }}
            >
              Mais antigas
            </button>
          </nav>
        )}
      </aside>

      <div className="inbox-thread panel">
        {!selectedId || !thread ? (
          <Empty
            title="Selecione uma conversa"
            description="Escolha um atendimento para visualizar o histórico."
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
                  <h2>{selectedConversation?.contact_name ?? 'Contato'}</h2>
                  {user.role === 'manager' && selectedConversation && (
                    <p className="thread-owner">Responsável: {ownerLabel(selectedConversation)}</p>
                  )}
                </div>
              </div>
              <div className="thread-actions">
                {selectedConversation?.review_shared && (
                  <button
                    type="button"
                    className="button gold compact"
                    disabled={!connected || assuming}
                    onClick={() => void assumeConversation()}
                  >
                    {assuming ? 'Assumindo…' : 'Assumir conversa'}
                  </button>
                )}
                {selectedConversation?.state === 'CLAIMED' &&
                  (user.role === 'manager' || selectedConversation.owner_id === user.id) && (
                    <LeadQualityControl
                      key={thread.opportunity_id}
                      leadId={thread.opportunity_id}
                      reason={selectedConversation.non_commercial_reason}
                      disabled={!connected || sending}
                    />
                  )}
                {canControlNotifications && (
                  <button
                    type="button"
                    className={`button outline compact thread-notification-button${selectedConversation?.notifications_muted ? ' muted' : ''}`}
                    aria-label={
                      selectedConversation?.notifications_muted
                        ? 'Reativar notificações deste lead'
                        : 'Silenciar notificações deste lead'
                    }
                    title={
                      selectedConversation?.notifications_muted
                        ? 'Reativar notificações'
                        : 'Silenciar notificações'
                    }
                    disabled={!connected || notificationSaving}
                    onClick={() => void toggleNotifications()}
                  >
                    {selectedConversation?.notifications_muted ? (
                      <Bell size={15} />
                    ) : (
                      <BellOff size={15} />
                    )}
                    <span>
                      {selectedConversation?.notifications_muted ? 'Ativar avisos' : 'Silenciar'}
                    </span>
                  </button>
                )}
                {!selectedConversation?.review_shared && (
                  <button
                    className="button outline compact thread-lead-button"
                    aria-label="Abrir ficha do lead"
                    onClick={() => onOpenLead(thread.opportunity_id)}
                  >
                    <span>Abrir ficha</span> <ArrowRight size={15} />
                  </button>
                )}
              </div>
            </header>
            {selectedConversation?.non_commercial_reason && (
              <div className="quality-archive-note" role="status">
                {qualityReasons[selectedConversation.non_commercial_reason]} · Silenciado
                automaticamente. Mensagens continuam disponíveis sem notificações.
              </div>
            )}
            <div ref={messageListRef} className="thread-messages" aria-live="polite">
              {thread.has_older && (
                <button
                  type="button"
                  className="thread-load-older"
                  disabled={olderMessagesLoading}
                  onClick={() => void loadOlderMessages()}
                >
                  {olderMessagesLoading ? 'Carregandoâ€¦' : 'Carregar mensagens anteriores'}
                </button>
              )}
              {thread.messages.map((message) => (
                <article
                  key={message.id}
                  className={`thread-message ${message.direction === 'outbound' ? 'outbound' : 'inbound'}`}
                >
                  {message.type === 'instagram_comment' && (
                    <small className="comment-context">Comentário na publicação</small>
                  )}
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
            {thread.can_send && thread.messaging_mode === 'private_reply' && (
              <div className="thread-comment-notice">
                Primeira mensagem privada. Depois do envio, aguarde o lead responder.
              </div>
            )}
            {thread.can_send ? (
              <form className="thread-composer" onSubmit={submit}>
                {user.role === 'attendant' && (
                  <div className="shortcut-picker" ref={shortcutPickerRef}>
                    <button
                      ref={shortcutTriggerRef}
                      type="button"
                      className="shortcut-picker-trigger"
                      aria-label="Abrir atalhos de mensagem"
                      aria-expanded={shortcutPickerOpen}
                      aria-controls="chat-shortcuts"
                      disabled={sending || !connected}
                      onClick={() => void openShortcutPicker()}
                    >
                      <Zap size={18} />
                      <span>Atalhos</span>
                    </button>
                    {shortcutPickerOpen && (
                      <div
                        id="chat-shortcuts"
                        className="shortcut-picker-menu"
                        role="region"
                        aria-label="Atalhos de mensagem"
                      >
                        <div className="shortcut-picker-heading">
                          <strong>Atalhos</strong>
                          <small>Toque para enviar</small>
                        </div>
                        {shortcutsLoading ? (
                          <p className="shortcut-picker-empty">Carregando…</p>
                        ) : shortcuts.length ? (
                          <div className="shortcut-picker-list">
                            {shortcuts.map((shortcut) => (
                              <button
                                type="button"
                                key={shortcut.id}
                                disabled={sending || !connected}
                                onClick={() => void sendText(shortcut.body, false)}
                              >
                                <strong>{shortcut.name}</strong>
                                <span>{shortcut.body}</span>
                              </button>
                            ))}
                          </div>
                        ) : (
                          <p className="shortcut-picker-empty">
                            Cadastre seus atalhos no menu Atalhos.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <textarea
                  value={draft}
                  disabled={sending || !connected}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDrafts((current) => ({ ...current, [selectedId]: value }));
                  }}
                  maxLength={1000}
                  rows={2}
                  placeholder="Digite a resposta…"
                  aria-label={`Mensagem para o ${selectedConversation?.channel === 'messenger' ? 'Messenger' : 'Instagram'}`}
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
                  : selectedConversation?.review_shared
                    ? 'Esta conversa está disponível somente para leitura. Assuma para movê-la aos seus atendimentos e poder responder.'
                    : thread.messaging_mode === 'waiting_reply'
                      ? `Aguardando o lead responder no ${selectedConversation?.channel === 'messenger' ? 'Messenger' : 'Instagram'}.`
                      : thread.messaging_mode === 'send_unconfirmed'
                        ? `Envio não confirmado. Confira a conversa no ${selectedConversation?.channel === 'messenger' ? 'Messenger' : 'Instagram'} antes de uma nova abordagem.`
                        : thread.messaging_mode === 'expired'
                          ? 'Prazo de envio encerrado. Aguarde uma nova mensagem do lead.'
                          : 'Assuma o lead antes de responder pelo CRM.'}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
