import { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, MessageCircle, RefreshCw } from 'lucide-react';
import { api, ApiError, type User } from './api';
import { Empty } from './components';
import { signalWithTimeout } from './abort';

interface Comment {
  id: string;
  username: string;
  text: string;
  permalink: string;
  thumbnail_url: string;
  reply_deadline_at: string;
  created_at: string;
  version: number;
  comment_count: number;
  can_claim?: boolean;
}
interface Result {
  configured: boolean;
  comments: Comment[];
  next_cursor: string | null;
}

export function CommentPool({
  user,
  onOpenChat,
  onSessionExpired,
}: {
  user: User;
  onOpenChat: (id: string) => void;
  onSessionExpired: () => Promise<void>;
}) {
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const mutation = useRef(false);
  const paginated = useRef(false);
  const request = useRef<AbortController | null>(null);
  const load = useCallback(
    async (before?: string, quiet = false) => {
      if (quiet && request.current) return;
      const seq = ++sequence.current;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      const timed = signalWithTimeout(controller.signal, 20_000);
      try {
        const next = await api<Result>(
          `/instagram/comments${before ? `?before=${encodeURIComponent(before)}` : ''}`,
          { signal: timed.signal },
        );
        if (!mounted.current || seq !== sequence.current) return;
        paginated.current = Boolean(before);
        setResult((previous) => ({
          ...next,
          comments: before
            ? [
                ...new Map(
                  [...(previous?.comments ?? []), ...next.comments].map((comment) => [
                    comment.id,
                    comment,
                  ]),
                ).values(),
              ]
            : next.comments,
        }));
        setError('');
      } catch (err) {
        if (!mounted.current || controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 401) void onSessionExpired();
        else if (!quiet)
          setError(
            err instanceof Error ? err.message : 'Não foi possível carregar os comentários.',
          );
      } finally {
        timed.dispose();
        if (request.current === controller) request.current = null;
        if (mounted.current && seq === sequence.current) setLoadingMore(false);
      }
    },
    [onSessionExpired],
  );
  useEffect(() => {
    mounted.current = true;
    void load();
    // Refresh only the first page automatically; don't remove the user's loaded history.
    const timer = window.setInterval(() => {
      if (!document.hidden && !mutation.current && !paginated.current) void load(undefined, true);
    }, 15_000);
    return () => {
      mounted.current = false;
      sequence.current++;
      request.current?.abort();
      clearInterval(timer);
    };
  }, [load]);
  const act = async (comment: Comment, action: 'claim' | 'ignore') => {
    if (mutation.current) return;
    mutation.current = true;
    setBusy(comment.id);
    setError('');
    try {
      const response = await api<{ opportunity_id: string }>(
        `/instagram/comments/${comment.id}/${action}`,
        {
          method: 'POST',
          body: JSON.stringify({ expected_version: comment.version }),
        },
      );
      if (!mounted.current) return;
      if (action === 'claim') onOpenChat(response.opportunity_id);
      else await load();
    } catch (err) {
      if (!mounted.current) return;
      if (err instanceof ApiError && err.status === 401) void onSessionExpired();
      else {
        await load();
        setError(err instanceof Error ? err.message : 'Não foi possível concluir.');
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy('');
    }
  };
  return (
    <section className="panel comment-pool" aria-label="Bolsão de comentários">
      <div className="panel-heading">
        <div>
          <h2>Comentários do Instagram</h2>
          <p>Assuma um perfil para iniciar o atendimento.</p>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Atualizar comentários"
          disabled={!!busy}
          onClick={() => void load()}
        >
          <RefreshCw size={18} />
        </button>
      </div>
      {error && (
        <p className="comment-error" role="alert">
          {error}
        </p>
      )}
      {!result ? (
        <p className="muted">Carregando comentários…</p>
      ) : !result.configured ? (
        <Empty
          title="Instagram não conectado"
          description="A gestão precisa configurar a integração."
        />
      ) : !result.comments.length ? (
        <Empty
          title="Nenhum comentário disponível"
          description="Novos comentários aparecerão aqui quando forem recebidos do Instagram."
        />
      ) : (
        <>
          <div className="comment-grid">
            {result.comments.map((comment) => (
              <article className="comment-card" key={comment.id}>
                <div className="comment-profile">
                  <span className="comment-avatar" aria-hidden="true">
                    <MessageCircle size={20} />
                  </span>
                  {comment.username ? (
                    <a
                      href={`https://www.instagram.com/${encodeURIComponent(comment.username)}/`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      @{comment.username} <ExternalLink size={13} />
                    </a>
                  ) : (
                    <strong>Perfil do Instagram</strong>
                  )}
                  {comment.comment_count > 1 && <small>{comment.comment_count} comentários</small>}
                </div>
                <p className="comment-text">{comment.text || 'Comentário sem texto'}</p>
                {comment.permalink && (
                  <a
                    className="comment-publication"
                    href={comment.permalink}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {comment.thumbnail_url && (
                      <img
                        src={comment.thumbnail_url}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        onError={(event) => {
                          event.currentTarget.hidden = true;
                        }}
                      />
                    )}
                    Ver publicação <ExternalLink size={13} />
                  </a>
                )}
                <small className="muted">
                  Responder até{' '}
                  {new Intl.DateTimeFormat('pt-BR', {
                    day: '2-digit',
                    month: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                  }).format(new Date(comment.reply_deadline_at))}
                </small>
                {user.role === 'attendant' && (
                  <div className="comment-actions">
                    <button
                      className="button outline compact"
                      disabled={!!busy || comment.can_claim === false}
                      onClick={() => void act(comment, 'ignore')}
                    >
                      Ignorar
                    </button>
                    <button
                      className="button gold compact"
                      disabled={!!busy || comment.can_claim === false}
                      onClick={() => void act(comment, 'claim')}
                    >
                      <MessageCircle size={16} />
                      {comment.can_claim === false ? 'Perfil reservado' : busy === comment.id ? 'Aguarde…' : 'Assumir e conversar'}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </div>
          {result.next_cursor && (
            <button
              className="button outline"
              disabled={loadingMore || !!busy}
              onClick={() => {
                setLoadingMore(true);
                void load(result.next_cursor!);
              }}
            >
              {loadingMore ? 'Carregando…' : 'Carregar mais'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
