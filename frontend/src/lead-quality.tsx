import './lead-quality.css';
import { useEffect, useRef, useState } from 'react';
import { Tag } from 'lucide-react';
import { api, ApiError } from './api';
import { Modal } from './components';
import { signalWithTimeout } from './abort';

export const qualityReasons: Record<string, string> = {
  ADVERTISING: 'Vendas e propagandas',
  JOB_SEEKER: 'Procura de emprego',
  NON_COMMERCIAL_MENTION: 'Marcação não comercial da clínica',
  POLITICAL_VIDEO: 'Vídeos políticos',
};
interface Quality {
  id: string;
  version: number;
  reason: string | null;
  marked_at: string | null;
  marked_by_name: string | null;
  can_mark: boolean;
  can_restore: boolean;
  will_compensate: boolean;
  compensation_status: 'pending' | 'used' | 'revoked' | null;
}
export function notifyQualityChanged(leadId: string, message?: string) {
  window.dispatchEvent(new CustomEvent('artisti-lead-quality', { detail: { leadId, message } }));
  try {
    localStorage.setItem('artisti-lead-quality', JSON.stringify({ leadId, at: Date.now() }));
  } catch {
    /* Private browsing. */
  }
}
export function LeadQualityControl({
  leadId,
  reason,
  disabled = false,
}: {
  leadId: string;
  reason?: string | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [quality, setQuality] = useState<Quality | null>(null);
  const [chosen, setChosen] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setQuality(null);
    setError('');
    setNotice('');
    void api<Quality>(`/opportunities/${leadId}/quality`, { signal: controller.signal })
      .then((value) => {
        setQuality(value);
        setChosen(value.reason ?? '');
      })
      .catch((err) => {
        if (!controller.signal.aborted) setError((err as Error).message);
      });
    return () => controller.abort();
  }, [leadId, open, reason]);
  const save = async (nextReason: string | null) => {
    if (!quality || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const request = signalWithTimeout(new AbortController().signal, 20_000);
    try {
      const result = await api<Pick<Quality, 'version' | 'reason' | 'compensation_status'>>(
        `/opportunities/${leadId}/quality`,
        {
          method: 'PUT',
          signal: request.signal,
          body: JSON.stringify({ reason: nextReason, expected_version: quality.version }),
        },
      );
      setQuality({ ...quality, ...result });
      const message = !nextReason
        ? 'Atendimento restaurado.'
        : result.compensation_status === 'pending'
          ? 'Classificado e silenciado. Reposição registrada.'
          : 'Classificado e silenciado. Sem alteração no rodízio.';
      setNotice(message);
      notifyQualityChanged(leadId, message);
    } catch (err) {
      setError(
        request.signal.aborted
          ? 'A confirmação demorou. Tente novamente; uma marcação já salva não será duplicada.'
          : (err as Error).message,
      );
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        const current = await api<Quality>(`/opportunities/${leadId}/quality`).catch(() => null);
        if (current) {
          setQuality(current);
          setChosen(current.reason ?? '');
        }
      }
    } finally {
      request.dispose();
      saving.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        className={`button outline compact quality-trigger${reason ? ' is-marked' : ''}`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        <Tag size={15} />
        <span>{reason ? (qualityReasons[reason] ?? 'Não comercial') : 'Marcar não comercial'}</span>
      </button>
      {open && (
        <Modal
          title="Classificação do contato"
          description="Escolha o motivo para retirar este contato dos indicadores comerciais e silenciar suas notificações."
          onClose={() => {
            if (!saving.current) setOpen(false);
          }}
        >
          <div className="modal-body quality-panel">
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="quality-notice">
                {notice}
              </p>
            )}
            {!quality && !error && <p>Carregando classificação…</p>}
            {quality && (
              <>
                {quality.reason && (
                  <div className="quality-summary">
                    <strong>{qualityReasons[quality.reason]}</strong>
                    <p>Silenciado automaticamente. O histórico permanece disponível.</p>
                    {quality.marked_by_name && (
                      <p>
                        Marcado por {quality.marked_by_name}
                        {quality.marked_at
                          ? ` em ${new Date(quality.marked_at).toLocaleString('pt-BR')}`
                          : ''}
                        .
                      </p>
                    )}
                    <p>
                      {quality.compensation_status === 'pending'
                        ? 'Reposição aguardando distribuição.'
                        : quality.compensation_status === 'used'
                          ? 'Reposição já entregue.'
                          : quality.compensation_status === 'revoked'
                            ? 'Reposição cancelada após correção.'
                            : 'Sem reposição de rodízio.'}
                    </p>
                  </div>
                )}
                {quality.can_mark && (
                  <>
                    <label className="quality-label">
                      Motivo
                      <select
                        aria-label="Motivo da classificação"
                        value={chosen}
                        disabled={busy}
                        onChange={(e) => setChosen(e.target.value)}
                      >
                        <option value="">Selecione um motivo</option>
                        {Object.entries(qualityReasons).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!quality.reason && (
                      <p className="muted">
                        {quality.will_compensate
                          ? 'Uma reposição será registrada para o próximo lead disponível no rodízio.'
                          : 'Esta classificação não gera reposição nem altera o rodízio.'}{' '}
                        Novas mensagens deste contato ficarão silenciadas no CRM.
                      </p>
                    )}
                    <button
                      type="button"
                      className="button gold"
                      disabled={busy || !chosen || chosen === quality.reason}
                      onClick={() => void save(chosen)}
                    >
                      {busy ? 'Salvando…' : quality.reason ? 'Atualizar motivo' : 'Aplicar selo'}
                    </button>
                  </>
                )}
                {quality.reason && quality.can_restore && (
                  <button
                    type="button"
                    className="button outline"
                    disabled={busy}
                    onClick={() => void save(null)}
                  >
                    Restaurar atendimento
                  </button>
                )}
              </>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
