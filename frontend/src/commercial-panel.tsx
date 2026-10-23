import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { Upload, CheckCircle2, AlertCircle, FileImage, RefreshCw } from 'lucide-react';
import {
  commercialDate,
  commercialMoney,
  commercialReasons,
  commercialStatus,
  evidenceLabels,
  uploadCommercialEvidence,
  type CommercialSummary,
  type CommercialSuggestions,
  type CommercialJob,
  type CommercialExtraction,
  type EvidenceCategory,
} from './commercial-api';
import './commercial.css';

export function useCommercialEnabled() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ enabled: boolean }>('/commercial/config', { signal: controller.signal })
      .then((result) => setEnabled(result.enabled))
      .catch(() => {});
    return () => controller.abort();
  }, []);
  return enabled;
}
type SelectedFile = { file: File; key: string; url: string; progress: number; evidenceId?: string };
const freshExtraction = (): CommercialExtraction => ({
  patient_name: null,
  readable: true,
  warnings: [],
  payment: null,
  contract: null,
  fields: {
    total_value_cents: null,
    hair_grade_classification: null,
    pack_quantity: null,
    procedure_date: null,
  },
});

export function CommercialPanel({
  id,
  opportunityVersion,
  patientName,
  onSuggestions,
}: {
  id: string;
  opportunityVersion: number;
  patientName: string;
  onSuggestions: (fields: CommercialSuggestions) => void;
}) {
  const enabled = useCommercialEnabled();
  const [data, setData] = useState<CommercialSummary | null>(null);
  const [category, setCategory] = useState<EvidenceCategory>('payment');
  const [files, setFiles] = useState<SelectedFile[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [review, setReview] = useState<CommercialJob | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeReason, setRemoveReason] = useState('');
  const [legacyMinimum, setLegacyMinimum] = useState('200000');
  const [legacyReason, setLegacyReason] = useState('');
  const fileRef = useRef(files);
  fileRef.current = files;
  const mounted = useRef(true);
  const inFlight = useRef<Promise<CommercialSummary> | null>(null);
  const loadController = useRef<AbortController | null>(null);
  const uploadController = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const command = useRef<{ identity: string; key: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const load = useCallback((): Promise<CommercialSummary> => {
    if (inFlight.current) return inFlight.current;
    const controller = new AbortController();
    loadController.current = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error('A consulta demorou. Tente atualizar novamente.')),
      20000,
    );
    const pending = api<CommercialSummary>(`/opportunities/${id}/commercial`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (mounted.current) setData(result);
        return result;
      })
      .finally(() => {
        clearTimeout(timeout);
        if (inFlight.current === pending) inFlight.current = null;
      });
    inFlight.current = pending;
    return pending;
  }, [id]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadController.current?.abort();
      inFlight.current = null;
      uploadController.current?.abort();
      for (const file of fileRef.current) URL.revokeObjectURL(file.url);
    };
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () => {
      if (!document.hidden)
        void load().catch((e) => {
          if (active && e.name !== 'AbortError') setError(e.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled, load, opportunityVersion]);
  useEffect(() => {
    if (data) onSuggestions(data.suggestions);
  }, [data, onSuggestions]);

  const send = async (path: string, payload: object) => {
    const identity = JSON.stringify({ path, payload });
    if (command.current && command.current.identity !== identity)
      throw new Error(
        'Há uma solicitação sem confirmação. Atualize a ficha para verificar o resultado antes de continuar.',
      );
    command.current ??= { identity, key: crypto.randomUUID() };
    try {
      const result = await api(`/opportunities/${id}/commercial${path}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': command.current.key },
        body: JSON.stringify(payload),
      });
      command.current = null;
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.status < 500) command.current = null;
      throw e;
    }
  };
  const action = async (work: () => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const selectFiles = (selected: FileList | null) => {
    if (!selected) return;
    const next = Array.from(selected);
    if (
      next.length > 4 ||
      next.some(
        (f) =>
          !['image/jpeg', 'image/png', 'image/webp'].includes(f.type) || f.size > 8 * 1024 * 1024,
      )
    ) {
      setError('Selecione até 4 imagens JPG, PNG ou WebP, de até 8 MB cada.');
      return;
    }
    fileRef.current.forEach((f) => URL.revokeObjectURL(f.url));
    setFiles(
      next.map((file) => ({
        file,
        key: crypto.randomUUID(),
        url: URL.createObjectURL(file),
        progress: 0,
      })),
    );
    setError('');
  };
  const upload = () =>
    action(async () => {
      const controller = new AbortController();
      uploadController.current = controller;
      const ids: string[] = [];
      for (const file of files) {
        let eid = file.evidenceId;
        if (!eid) {
          const result = await uploadCommercialEvidence(
            id,
            category,
            file.file,
            file.key,
            (progress) => {
              if (mounted.current)
                setFiles((current) =>
                  current.map((item) => (item.key === file.key ? { ...item, progress } : item)),
                );
            },
            controller.signal,
          );
          eid = result.evidence_id;
          if (mounted.current)
            setFiles((current) =>
              current.map((item) =>
                item.key === file.key ? { ...item, evidenceId: eid, progress: 100 } : item,
              ),
            );
        }
        ids.push(eid);
      }
      // Refresh after uploads: each accepted file has its own revision.
      await load();
      const latest = await load();
      const usable = ids.filter((eid) =>
        latest.evidence.some(
          (e) => e.id === eid && ['uploaded', 'failed', 'needs_review'].includes(e.status),
        ),
      );
      if (usable.length)
        await send('/analyses', { evidence_ids: usable, expected_revision: latest.revision });
      if (mounted.current) {
        files.forEach((f) => URL.revokeObjectURL(f.url));
        setFiles([]);
        if (input.current) input.current.value = '';
        setNotice(
          usable.length
            ? 'Documentos recebidos. Você pode continuar o atendimento enquanto a checagem acontece.'
            : 'Esses documentos já estão registrados. Não foram duplicados.',
        );
      }
    });
  if (!enabled) return null;
  const summary = data?.assessment;
  return (
    <section className="commercial-evidence" aria-label="Documentos, sinal e comissão">
      {/* form="" detaches these independent controls from the surrounding sale form:
          document drafts must neither block its validation nor submit it with Enter. */}
      <header className="ce-heading">
        <div>
          <span>CHECAGEM DOCUMENTAL</span>
          <h3>Sinal, contrato e comissão</h3>
        </div>
        <button
          type="button"
          className="button outline"
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await load();
              command.current = null;
            })
          }
        >
          <RefreshCw size={15} /> Atualizar
        </button>
      </header>
      <p className="ce-intro">
        Envie os documentos de <strong>{patientName}</strong>. O cadastro da venda e a validação dos
        pagamentos são etapas separadas.
      </p>
      {!data && <p role="status">Carregando checagem…</p>}
      {summary && (
        <>
          <div className="ce-summary">
            <div>
              <span>Sinal confirmado</span>
              <strong>{commercialMoney(summary.confirmed_cents)}</strong>
              <small>mínimo {commercialMoney(summary.minimum_cents)}</small>
            </div>
            <div>
              <span>Em conferência</span>
              <strong>{commercialMoney(summary.pending_cents)}</strong>
              <small>não incluído no confirmado</small>
            </div>
            <div>
              <span>Falta confirmar</span>
              <strong>{commercialMoney(summary.remaining_cents)}</strong>
              <small>para completar o sinal</small>
            </div>
          </div>
          <div className={`ce-outcome ${summary.eligible ? 'is-ok' : ''}`} role="status">
            {summary.eligible ? <CheckCircle2 size={19} /> : <AlertCircle size={19} />}
            <div>
              <strong>
                {summary.eligible ? 'Elegível para comissão' : 'Comissão ainda não liberada'}
              </strong>
              {summary.eligible ? (
                <p>
                  Competência: {summary.commission_period?.split('-').reverse().join('/')} ·
                  Pagamento previsto: {commercialDate(summary.expected_payment_on)}. Não significa
                  comissão paga.
                </p>
              ) : (
                <>
                  <p>
                    {summary.reasons
                      .map((reason) => commercialReasons[reason] ?? reason)
                      .join(' · ')}
                  </p>
                  {summary.conditional_deadline_on && (
                    <p>
                      Previsão condicional: concluir as pendências até{' '}
                      {commercialDate(summary.conditional_deadline_on)} para o pagamento de{' '}
                      {commercialDate(summary.conditional_payment_on)}.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
          <p className="ce-note">
            Contrato:{' '}
            {summary.contract_signed_on
              ? `assinado e validado em ${commercialDate(summary.contract_signed_on)}`
              : 'assinatura ainda não validada'}
            . A data da cirurgia não bloqueia a comissão.
          </p>
          {data.late_validation && (
            <p className="ce-warning">
              Evidência validada após a data prevista. A gestão precisa conferir a inclusão no
              pagamento.
            </p>
          )}
        </>
      )}
      {data && !data.ai_enabled && (
        <p className="ce-warning">
          IA ainda não habilitada neste ambiente. Os documentos ficam disponíveis para conferência
          da gestão, sem confirmação automática.
        </p>
      )}
      {data?.can_review &&
        data.ai_enabled &&
        (!data.auto_validate || !data.recipient_check_configured) && (
          <p className="ce-warning">
            A liberação automática depende da ativação da validação e da configuração dos
            destinatários autorizados. Sem isso, os comprovantes seguem para revisão.
          </p>
        )}
      {!!data && Object.keys(data.suggestions).length > 0 && (
        <p className="ce-note">
          Os dados validados preenchem somente campos vazios que você ainda não editou. Revise os
          campos comerciais e salve o cadastro para registrar esse preenchimento.
        </p>
      )}
      <div className="ce-upload">
        <label>
          Tipo de documento
          <select
            form=""
            value={category}
            disabled={busy || files.some((f) => f.evidenceId)}
            onChange={(e) => setCategory(e.target.value as EvidenceCategory)}
          >
            {Object.entries(evidenceLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="ce-file-input">
          <Upload size={18} />
          <span>Escolher prints ou fotos</span>
          <input
            form=""
            ref={input}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            multiple
            disabled={busy}
            onChange={(e) => selectFiles(e.target.files)}
          />
        </label>
        <small>
          Até 4 imagens por envio, da mesma categoria. Um pagamento por checagem; várias páginas do
          mesmo documento podem ser enviadas juntas.
        </small>
        {!!files.length && (
          <div className="ce-previews">
            {files.map((file) => (
              <div key={file.key}>
                <img src={file.url} alt={`Prévia de ${file.file.name}`} />
                <span>{file.file.name}</span>
                <progress value={file.progress} max="100" />
                <small>
                  {file.evidenceId
                    ? 'Recebido pelo servidor'
                    : file.progress === 100
                      ? 'Confirmando recebimento…'
                      : `${file.progress}% enviado`}
                </small>
              </div>
            ))}
          </div>
        )}
        <button
          type="button"
          className="button gold"
          disabled={!files.length || busy || !data}
          onClick={() => void upload()}
        >
          <Upload size={16} />
          {busy ? 'Aguarde…' : 'Enviar para checagem'}
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="ce-note" role="status">
          {notice}
        </p>
      )}
      {!!data?.payments.length && (
        <details className="ce-details" open>
          <summary>Pagamentos registrados ({data.payments.length})</summary>
          <div className="ce-rows">
            {data.payments.map((payment) => (
              <div className="ce-row" key={payment.id}>
                <div>
                  <strong>{commercialMoney(payment.amount_cents)}</strong>
                  <small>{commercialDate(payment.paid_on)}</small>
                </div>
                <span className={`ce-badge ${payment.status === 'confirmed' ? 'is-ok' : ''}`}>
                  {commercialStatus[payment.status] ?? payment.status}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {!!data?.jobs.length && (
        <details className="ce-details" open>
          <summary>Resultado das checagens</summary>
          <div className="ce-rows">
            {data.jobs
              .slice()
              .reverse()
              .map((job) => (
                <div className="ce-job" key={job.id}>
                  <div className="ce-row">
                    <div>
                      <strong>{evidenceLabels[job.category]}</strong>
                      <small>{commercialStatus[job.status] ?? job.status}</small>
                    </div>
                    <div className="ce-actions">
                      {['failed', 'needs_review'].includes(job.status) && data.ai_enabled && (
                        <button
                          type="button"
                          className="button outline"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await send(`/analyses/${job.id}/retry`, {
                                expected_revision: data.revision,
                              });
                            })
                          }
                        >
                          Tentar leitura novamente
                        </button>
                      )}
                      {data.can_review && ['failed', 'needs_review'].includes(job.status) && (
                        <button
                          type="button"
                          className="button outline"
                          disabled={busy}
                          onClick={() => setReview(job)}
                        >
                          Revisar
                        </button>
                      )}
                    </div>
                  </div>
                  {!!job.reasons.length && (
                    <p>{job.reasons.map((r) => commercialReasons[r] ?? r).join(' · ')}</p>
                  )}
                  {job.error && (
                    <p>{commercialReasons[job.error] ?? 'A análise precisa ser refeita.'}</p>
                  )}
                </div>
              ))}
          </div>
        </details>
      )}
      {!!data?.evidence.length && (
        <details className="ce-details">
          <summary>Documentos enviados ({data.evidence.length})</summary>
          <div className="ce-rows">
            {data.evidence.map((evidence) => (
              <div className="ce-row" key={evidence.id}>
                <div>
                  <strong>
                    <FileImage size={16} /> {evidenceLabels[evidence.category]}
                  </strong>
                  <small>{commercialStatus[evidence.status]}</small>
                </div>
                <div className="ce-actions">
                  <button
                    type="button"
                    className="button outline"
                    onClick={() => setPreview(evidence.url)}
                  >
                    Ver imagem
                  </button>
                  {evidence.status === 'uploaded' && (
                    <button
                      type="button"
                      className="button outline"
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await send('/analyses', {
                            evidence_ids: [evidence.id],
                            expected_revision: data.revision,
                          });
                        })
                      }
                    >
                      Checar
                    </button>
                  )}
                  {evidence.status !== 'superseded' && (
                    <button
                      type="button"
                      className="button outline"
                      disabled={busy}
                      onClick={() => {
                        setRemoving(evidence.id);
                        setRemoveReason('');
                      }}
                    >
                      Desconsiderar
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      {removing && (
        <div className="ce-review" role="group" aria-label="Desconsiderar documento">
          <p>
            O arquivo será preservado no histórico, mas seus pagamentos e assinatura deixarão de
            contar até uma nova validação.
          </p>
          <label>
            Motivo
            <textarea
              form=""
              value={removeReason}
              onChange={(e) => setRemoveReason(e.target.value)}
              maxLength={500}
            />
          </label>
          <div className="ce-actions">
            <button type="button" className="button outline" onClick={() => setRemoving(null)}>
              Cancelar
            </button>
            <button
              type="button"
              className="button gold"
              disabled={busy || removeReason.trim().length < 10}
              onClick={() =>
                void action(async () => {
                  await send(`/evidence/${removing}/supersede`, {
                    expected_revision: data!.revision,
                    reason: removeReason,
                  });
                  setRemoving(null);
                })
              }
            >
              Confirmar desconsideração
            </button>
          </div>
        </div>
      )}
      {review && data && (
        <HumanReview
          key={review.id}
          job={review}
          documents={data.evidence.filter((e) => review.evidence_ids.includes(e.id))}
          busy={busy}
          onClose={() => setReview(null)}
          onSubmit={(decision, result, reason) =>
            void action(async () => {
              await send(`/analyses/${review.id}/review`, {
                expected_revision: data.revision,
                decision,
                ...(decision === 'confirm' ? { result } : {}),
                reason,
              });
              setReview(null);
            })
          }
        />
      )}
      {data?.can_review && summary?.reasons.includes('LEGACY_POLICY_REVIEW') && (
        <div className="ce-review">
          <h4>Vigência histórica</h4>
          <p>
            O fechamento começou antes de 01/10/2026. Confira o mínimo aplicável sem alterar a regra
            dos novos negócios.
          </p>
          <label>
            Mínimo documentado
            <select
              form=""
              value={legacyMinimum}
              onChange={(e) => setLegacyMinimum(e.target.value)}
            >
              <option value="200000">R$ 2.000</option>
              <option value="150000">R$ 1.500</option>
            </select>
          </label>
          <label>
            Justificativa
            <textarea
              form=""
              value={legacyReason}
              onChange={(e) => setLegacyReason(e.target.value)}
              maxLength={500}
            />
          </label>
          <button
            type="button"
            className="button outline"
            disabled={busy || legacyReason.trim().length < 10}
            onClick={() =>
              void action(async () => {
                await send('/legacy-policy', {
                  expected_revision: data.revision,
                  minimum_cents: Number(legacyMinimum),
                  reason: legacyReason,
                });
              })
            }
          >
            Confirmar vigência
          </button>
        </div>
      )}
      {preview && (
        <div
          className="ce-image-view"
          role="dialog"
          aria-label="Imagem do documento"
          aria-modal="true"
        >
          <button type="button" className="button outline" onClick={() => setPreview(null)}>
            Fechar imagem
          </button>
          <img src={preview} alt="Documento enviado para conferência" />
        </div>
      )}
      <p className="ce-note">
        A leitura confere os documentos enviados; não consulta o banco do paciente. Casos
        inconclusivos ficam pendentes para revisão.
      </p>
    </section>
  );
}

function HumanReview({
  job,
  documents,
  busy,
  onClose,
  onSubmit,
}: {
  job: CommercialJob;
  documents: CommercialSummary['evidence'];
  busy: boolean;
  onClose: () => void;
  onSubmit: (decision: 'confirm' | 'reject', result: CommercialExtraction, reason: string) => void;
}) {
  const [result, setResult] = useState<CommercialExtraction>(() => {
    const initial = structuredClone(job.result ?? freshExtraction());
    if (job.category === 'payment' && !initial.payment)
      initial.payment = {
        amount_cents: null,
        paid_on: null,
        payer_name: null,
        recipient_name: null,
        recipient_identifier: null,
        transaction_id: null,
        state: 'unknown',
      };
    if (job.category === 'signature' && !initial.contract)
      initial.contract = { signed_on: null, state: 'unknown', contract_id: null };
    return initial;
  });
  const [reason, setReason] = useState('');
  const [checked, setChecked] = useState(false);
  const patchPayment = (patch: Partial<NonNullable<CommercialExtraction['payment']>>) =>
    setResult((r) => ({ ...r, payment: { ...r.payment!, ...patch } }));
  const patchContract = (patch: Partial<NonNullable<CommercialExtraction['contract']>>) =>
    setResult((r) => ({ ...r, contract: { ...r.contract!, ...patch } }));
  return (
    <div className="ce-review" role="group" aria-label="Revisão humana">
      <h4>Conferência da gestão — {evidenceLabels[job.category]}</h4>
      <div className="ce-actions">
        {documents.map((document, index) => (
          <a key={document.id} href={document.url} target="_blank" rel="noreferrer">
            Abrir documento {index + 1}
          </a>
        ))}
      </div>
      <div className="ce-review-fields">
        <label>
          Paciente identificado
          <input
            form=""
            value={result.patient_name ?? ''}
            onChange={(e) => setResult({ ...result, patient_name: e.target.value || null })}
            maxLength={240}
          />
        </label>
        {result.payment && (
          <>
            <label>
              Valor recebido (R$)
              <input
                form=""
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                value={
                  result.payment.amount_cents === null ? '' : result.payment.amount_cents / 100
                }
                onChange={(e) =>
                  patchPayment({
                    amount_cents: e.target.value ? Math.round(Number(e.target.value) * 100) : null,
                  })
                }
              />
            </label>
            <label>
              Data efetiva do pagamento
              <input
                form=""
                type="date"
                value={result.payment.paid_on ?? ''}
                onChange={(e) => patchPayment({ paid_on: e.target.value || null })}
              />
            </label>
            <label>
              Situação da transação
              <select
                form=""
                value={result.payment.state}
                onChange={(e) =>
                  patchPayment({
                    state: e.target.value as NonNullable<CommercialExtraction['payment']>['state'],
                  })
                }
              >
                <option value="unknown">Não comprovada</option>
                <option value="completed">Concluída</option>
                <option value="scheduled">Agendada</option>
                <option value="failed">Não realizada</option>
              </select>
            </label>
            <label>
              Identificador da transação
              <input
                form=""
                value={result.payment.transaction_id ?? ''}
                onChange={(e) => patchPayment({ transaction_id: e.target.value || null })}
                maxLength={240}
              />
            </label>
          </>
        )}
        {result.contract && (
          <>
            <label>
              Data efetiva da assinatura
              <input
                form=""
                type="date"
                value={result.contract.signed_on ?? ''}
                onChange={(e) => patchContract({ signed_on: e.target.value || null })}
              />
            </label>
            <label>
              Situação da assinatura
              <select
                form=""
                value={result.contract.state}
                onChange={(e) =>
                  patchContract({
                    state: e.target.value as NonNullable<CommercialExtraction['contract']>['state'],
                  })
                }
              >
                <option value="unknown">Não comprovada</option>
                <option value="signed">Assinado</option>
                <option value="not_signed">Não assinado</option>
              </select>
            </label>
          </>
        )}
        {job.category === 'contract_summary' && (
          <>
            <label>
              Valor total (R$)
              <input
                form=""
                type="number"
                min="0"
                step="0.01"
                value={
                  result.fields.total_value_cents === null
                    ? ''
                    : result.fields.total_value_cents / 100
                }
                onChange={(e) =>
                  setResult({
                    ...result,
                    fields: {
                      ...result.fields,
                      total_value_cents: e.target.value
                        ? Math.round(Number(e.target.value) * 100)
                        : null,
                    },
                  })
                }
              />
            </label>
            <label>
              Grau e classificação
              <input
                form=""
                value={result.fields.hair_grade_classification ?? ''}
                onChange={(e) =>
                  setResult({
                    ...result,
                    fields: { ...result.fields, hair_grade_classification: e.target.value || null },
                  })
                }
              />
            </label>
            <label>
              Quantidade de packs
              <input
                form=""
                type="number"
                min="0"
                step="1"
                value={result.fields.pack_quantity ?? ''}
                onChange={(e) =>
                  setResult({
                    ...result,
                    fields: {
                      ...result.fields,
                      pack_quantity: e.target.value ? Number(e.target.value) : null,
                    },
                  })
                }
              />
            </label>
          </>
        )}
        {['surgery', 'contract_summary'].includes(job.category) && (
          <label>
            Data da cirurgia
            <input
              form=""
              type="date"
              value={result.fields.procedure_date ?? ''}
              onChange={(e) =>
                setResult({
                  ...result,
                  fields: { ...result.fields, procedure_date: e.target.value || null },
                })
              }
            />
          </label>
        )}
      </div>
      <label>
        Justificativa da decisão
        <textarea
          form=""
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
      </label>
      <label className="ce-check">
        <input
          form=""
          type="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        Conferi os documentos, o vínculo com o paciente e os dados acima.
      </label>
      <div className="ce-actions">
        <button type="button" className="button outline" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
        <button
          type="button"
          className="button outline"
          disabled={busy || reason.trim().length < 10}
          onClick={() => onSubmit('reject', result, reason)}
        >
          Rejeitar evidência
        </button>
        <button
          type="button"
          className="button gold"
          disabled={busy || !checked || reason.trim().length < 10}
          onClick={() => onSubmit('confirm', result, reason)}
        >
          Confirmar fatos conferidos
        </button>
      </div>
    </div>
  );
}
