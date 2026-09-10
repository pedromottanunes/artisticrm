import { useEffect, useState } from 'react';
import { api } from './api';

interface CentralStatus {
  configured: boolean;
  pending: number;
  retrying: number;
  last_received_at: string | null;
  last_processed_at: string | null;
}
export function CentralStatusPanel() {
  const [status, setStatus] = useState<CentralStatus>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await api<CentralStatus>('/whatsapp/status');
        if (live) {
          setStatus(next);
          setError(false);
        }
      } catch {
        if (live) setError(true);
      } finally {
        busy = false;
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  const date = (value: string | null) =>
    value ? new Date(value).toLocaleString('pt-BR') : 'Nenhum evento';
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>WhatsApp central</h2>
      </div>
      <div className="integration-list">
        <div>
          <span>Recebimento pela API oficial</span>
          <span className="badge pending">
            {error
              ? 'Consulta indisponível'
              : !status
                ? 'Consultando…'
                : status.configured
                  ? 'Configurado'
                  : 'Desligado'}
          </span>
        </div>
        {status?.configured && (
          <>
            <div>
              <span>Aguardando processamento</span>
              <strong>{status.pending}</strong>
            </div>
            <div>
              <span>Em nova tentativa</span>
              <strong>{status.retrying}</strong>
            </div>
            <div>
              <span>Última mensagem recebida</span>
              <span>{date(status.last_received_at)}</span>
            </div>
            <div>
              <span>Último processamento</span>
              <span>{date(status.last_processed_at)}</span>
            </div>
          </>
        )}
      </div>
      <p className="help-text">
        Configuração feita no servidor, sem credenciais no navegador. “Configurado” não comprova
        entrega pela Meta: confirme com uma mensagem de teste. A central não envia respostas.
      </p>
    </section>
  );
}
