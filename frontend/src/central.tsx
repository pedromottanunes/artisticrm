import { useEffect, useState } from 'react';
import { api } from './api';

interface CentralStatus {
  configured: boolean;
  pending: number;
  retrying: number;
  last_received_at: string | null;
  last_processed_at: string | null;
}

const channels = [
  ['whatsapp', 'WhatsApp'],
  ['instagram', 'Instagram Direct'],
] as const;

export function CentralStatusPanel() {
  const [statuses, setStatuses] = useState<Record<string, CentralStatus>>({});
  const [errors, setErrors] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let live = true;
    let busy = false;
    const refresh = async () => {
      if (busy) return;
      busy = true;
      const entries = await Promise.all(
        channels.map(async ([channel]) => {
          try {
            return [channel, await api<CentralStatus>(`/${channel}/status`), false] as const;
          } catch {
            return [channel, undefined, true] as const;
          }
        }),
      );
      if (live) {
        setStatuses(
          Object.fromEntries(
            entries.filter((entry) => entry[1]).map(([channel, status]) => [channel, status!]),
          ),
        );
        setErrors(Object.fromEntries(entries.map(([channel, , error]) => [channel, error])));
      }
      busy = false;
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
    <>
      {channels.map(([channel, label]) => {
        const status = statuses[channel];
        const error = errors[channel];
        return (
          <section className="panel" key={channel}>
            <div className="panel-heading">
              <h2>{channel === 'whatsapp' ? 'WhatsApp central' : label}</h2>
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
              {channel === 'whatsapp'
                ? 'Configuração feita no servidor, sem credenciais no navegador. “Configurado” não comprova entrega pela Meta: confirme com uma mensagem de teste. A central não envia respostas.'
                : 'Configuração separada do WhatsApp. Depois do aceite, a responsável responde o Direct pela caixa de entrada do CRM.'}
            </p>
          </section>
        );
      })}
    </>
  );
}
