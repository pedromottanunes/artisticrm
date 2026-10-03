import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, Clock3 } from 'lucide-react';
import { api, ApiError, type Appointment } from './api';
import { Empty } from './components';
import './agenda.css';

interface AgendaResult {
  items: Appointment[];
  next_cursor: string | null;
}
export function Agenda({
  revision,
  onOpen,
  onSessionExpired,
  onConnectionChange,
}: {
  revision: number;
  onOpen: (id: string) => void;
  onSessionExpired: () => void;
  onConnectionChange: (connected: boolean) => void;
}) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? '';
  const [result, setResult] = useState<AgendaResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const callbacks = useRef({ onSessionExpired, onConnectionChange });
  callbacks.current = { onSessionExpired, onConnectionChange };
  useEffect(() => {
    let disposed = false;
    let active: AbortController | undefined;
    setResult(null);
    setLoading(true);
    const [year, number] = month.split('-').map(Number);
    const query = new URLSearchParams({
      from: new Date(year, number - 1, 1).toISOString(),
      to: new Date(year, number, 1).toISOString(),
      ...(cursor ? { cursor } : {}),
    });
    const load = async () => {
      if (disposed || active || document.hidden) return;
      const controller = new AbortController();
      active = controller;
      const timeout = setTimeout(() => controller.abort(), 20_000);
      try {
        const value = await api<AgendaResult>(`/appointments?${query}`, {
          signal: controller.signal,
        });
        if (disposed) return;
        setResult(value);
        setError('');
        callbacks.current.onConnectionChange(true);
      } catch (err) {
        if (disposed) return;
        setError('Não foi possível atualizar a agenda. Tentaremos novamente.');
        callbacks.current.onConnectionChange(false);
        if (err instanceof ApiError && err.status === 401) {
          setResult(null);
          callbacks.current.onSessionExpired();
        }
      } finally {
        clearTimeout(timeout);
        active = undefined;
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const refresh = () => void load();
    const timer = setInterval(refresh, 15_000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    return () => {
      disposed = true;
      clearInterval(timer);
      active?.abort();
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [month, cursor, revision]);
  return (
    <section className="panel agenda-panel">
      <div className="panel-heading">
        <div>
          <h2>Consultas</h2>
          <p>
            Horários no fuso deste dispositivo: {Intl.DateTimeFormat().resolvedOptions().timeZone}.
          </p>
        </div>
        <CalendarDays size={22} />
      </div>
      <div className="agenda-controls">
        <label>
          Mês{' '}
          <input
            type="month"
            aria-label="Mês da agenda"
            min="1900-01"
            max="2100-12"
            value={month}
            onChange={(event) => {
              const value = event.target.value;
              if (/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(value)) {
                setMonth(value);
                setCursors([]);
              }
            }}
          />
        </label>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {loading ? (
        <p className="agenda-message" role="status">
          Carregando consultas…
        </p>
      ) : result && !result.items.length ? (
        <Empty
          title="Nenhuma consulta neste período"
          description="Escolha outro mês ou agende uma consulta na ficha do lead."
        />
      ) : (
        <div className="appointment-list">
          {result?.items.map((item) => (
            <button
              className="appointment-card"
              key={item.id}
              onClick={() => onOpen(item.opportunity_id)}
            >
              <span className="calendar-date">
                <strong>{new Date(item.starts_at).getDate()}</strong>
                {new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(
                  new Date(item.starts_at),
                )}
              </span>
              <div>
                <strong>{item.name}</strong>
                <span>{item.unit}</span>
              </div>
              <span className="appointment-time">
                <Clock3 size={15} />
                {new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
                  new Date(item.starts_at),
                )}
              </span>
              <span className="stage-pill">
                {{
                  scheduled: 'Agendada',
                  attended: 'Compareceu',
                  no_show: 'Não compareceu',
                  cancelled: 'Cancelada',
                }[item.status] ?? item.status}
              </span>
              <ArrowUpRight size={18} />
            </button>
          ))}
        </div>
      )}
      {(cursors.length > 0 || result?.next_cursor) && (
        <div className="agenda-controls" aria-label="Paginação da agenda">
          <button
            className="button outline"
            disabled={loading || !cursors.length}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Anteriores
          </button>
          <span>Página {cursors.length + 1}</span>
          <button
            className="button outline"
            disabled={loading || !result?.next_cursor}
            onClick={() => {
              if (result?.next_cursor) setCursors((current) => [...current, result.next_cursor!]);
            }}
          >
            Próximas
          </button>
        </div>
      )}
    </section>
  );
}
