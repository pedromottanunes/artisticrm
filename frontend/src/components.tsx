import { useEffect, useRef, type ReactNode } from 'react';
import { X, ArrowUpRight, Inbox, Clock3 } from 'lucide-react';
import { stateLabels, type Lead, type User } from './api';

export function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button className="icon-button" aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}
export function Avatar({
  user,
  name,
  small = false,
}: {
  user?: User;
  name?: string;
  small?: boolean;
}) {
  const text = user?.name ?? name ?? '?';
  return (
    <span
      className={`avatar ${small ? 'small' : ''}`}
      style={user ? { color: user.color, background: `${user.color}18` } : undefined}
    >
      {text
        .split(' ')
        .map((s) => s[0])
        .slice(0, 2)
        .join('')}
    </span>
  );
}
export function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state.toLowerCase()}`}>
      <i />
      {stateLabels[state] ?? state}
    </span>
  );
}
export function Source({ value }: { value: string }) {
  return (
    <span className="source">
      <span
        className={`source-mark ${value === 'Google Ads' ? 'google' : value === 'Meta Ads' ? 'meta' : 'unknown'}`}
      >
        {value === 'Google Ads' ? 'G' : value === 'Meta Ads' ? '∞' : '↗'}
      </span>
      {value}
    </span>
  );
}
export function Empty({ title, description }: { title: string; description: string }) {
  return (
    <div className="empty">
      <span>
        <Inbox size={26} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
    </div>
  );
}
export function Modal({
  title,
  description,
  onClose,
  children,
  wide = false,
  className = '',
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const resize = () => {
      const viewport = window.visualViewport;
      dialog.style.setProperty(
        '--dialog-max-height',
        `${(viewport?.height ?? window.innerHeight) - 12}px`,
      );
      dialog.style.setProperty(
        '--dialog-keyboard-offset',
        `${Math.max(0, window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0))}px`,
      );
    };
    resize();
    window.visualViewport?.addEventListener('resize', resize);
    window.visualViewport?.addEventListener('scroll', resize);
    dialog.showModal();
    return () => {
      dialog.close();
      document.body.style.overflow = previous;
      window.visualViewport?.removeEventListener('resize', resize);
      window.visualViewport?.removeEventListener('scroll', resize);
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''} ${className}`.trim()}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label={title}
    >
      <div className="modal-heading">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <IconButton label="Fechar janela" onClick={onClose}>
          <X size={20} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
export function Countdown({ lead, now }: { lead: Pick<Lead, 'expires_at'>; now: number }) {
  const diff = Math.max(0, Math.ceil((new Date(lead.expires_at ?? 0).getTime() - now) / 1000));
  return (
    <span className={`countdown ${diff < 120 ? 'urgent' : ''}`}>
      <Clock3 size={13} />
      {diff === 0
        ? 'Prazo encerrado'
        : `${String(Math.floor(diff / 60)).padStart(2, '0')}:${String(diff % 60).padStart(2, '0')}`}
    </span>
  );
}
export function TextLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-link" onClick={onClick}>
      {children}
      <ArrowUpRight size={15} />
    </button>
  );
}
export function dateLabel(value: string, withTime = false) {
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(new Date(value));
}
