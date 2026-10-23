import { ApiError } from './api';
export type EvidenceCategory = 'payment' | 'signature' | 'contract_summary' | 'surgery';
export const evidenceLabels: Record<EvidenceCategory, string> = {
  payment: 'Comprovante de pagamento',
  signature: 'Assinatura no Amigo One',
  contract_summary: 'Resumo do contrato',
  surgery: 'Agenda da cirurgia',
};
export const commercialReasons: Record<string, string> = {
  DEPOSIT_INCOMPLETE: 'Sinal incompleto',
  CONTRACT_PENDING: 'Assinatura pendente de validação',
  SALE_NOT_REGISTERED: 'Falta registrar a venda',
  LEGACY_POLICY_REVIEW: 'Gestão precisa conferir a vigência do sinal antigo',
  EVIDENCE_REVIEW: 'Documento conflitante em revisão',
  AI_DISABLED: 'Leitura por IA ainda não habilitada',
  AUTO_VALIDATION_DISABLED: 'Validação automática ainda não habilitada',
  DOCUMENT_UNCLEAR: 'Imagem incompleta ou leitura incerta',
  PATIENT_MISMATCH: 'Identificação do paciente precisa de conferência',
  PAYMENT_NOT_PROVEN: 'Pagamento realizado ainda não comprovado',
  RECIPIENT_REVIEW: 'Destinatário do pagamento precisa de conferência',
  TRANSACTION_ID_MISSING: 'Identificador da transação não encontrado',
  DUPLICATE_PAYMENT: 'Possível pagamento já registrado',
  PAYMENT_CONFLICT: 'Dados diferentes para a mesma transação',
  SIGNATURE_NOT_PROVEN: 'Assinatura e data ainda não comprovadas',
  SIGNATURE_CONFLICT: 'Datas de assinatura divergentes',
  SURGERY_DATE_MISSING: 'Data da cirurgia não identificada',
  AI_UNAVAILABLE: 'IA temporariamente indisponível',
  AI_REQUEST_FAILED: 'Não foi possível consultar a IA',
  AI_INVALID_RESULT: 'A leitura precisa ser refeita ou revisada',
  ANALYSIS_FAILED: 'A checagem não foi concluída',
  AI_EMPTY_RESPONSE: 'A IA não retornou a leitura',
  AI_ATTEMPTS_EXHAUSTED: 'A análise foi interrompida. Reenvie para checagem ou solicite revisão.',
  FIELD_CONFLICT: 'Os dados do documento divergem dos campos já informados',
  EMPTY_EXTRACTION: 'Nenhum campo comercial foi identificado com segurança',
};
export const commercialStatus: Record<string, string> = {
  uploaded: 'Recebido — falta checar',
  queued: 'Aguardando análise',
  processing: 'Em análise',
  confirmed: 'Validado',
  done: 'Checagem concluída',
  needs_review: 'Revisão necessária',
  pending: 'Aguardando conferência',
  failed: 'Falha na análise',
  rejected: 'Rejeitado',
  superseded: 'Desconsiderado',
  cancelled: 'Cancelado',
};
export const commercialMoney = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100);
export const commercialDate = (date: string | null) =>
  date ? date.slice(0, 10).split('-').reverse().join('/') : '—';
export interface CommercialAssessment {
  rule_version: string;
  minimum_cents: number;
  confirmed_cents: number;
  pending_cents: number;
  remaining_cents: number;
  first_payment_on: string | null;
  deposit_completed_on: string | null;
  contract_signed_on: string | null;
  closing_started_on: string | null;
  requirements_completed_on: string | null;
  eligible: boolean;
  reasons: string[];
  commission_period: string | null;
  expected_payment_on: string | null;
  conditional_payment_on: string | null;
  conditional_deadline_on: string | null;
}
export interface CommercialExtraction {
  patient_name: string | null;
  readable: boolean;
  warnings: string[];
  payment: {
    amount_cents: number | null;
    paid_on: string | null;
    payer_name: string | null;
    recipient_name: string | null;
    recipient_identifier: string | null;
    transaction_id: string | null;
    state: 'completed' | 'scheduled' | 'failed' | 'unknown';
  } | null;
  contract: {
    signed_on: string | null;
    contract_id: string | null;
    state: 'signed' | 'not_signed' | 'unknown';
  } | null;
  fields: {
    total_value_cents: number | null;
    hair_grade_classification: string | null;
    pack_quantity: number | null;
    procedure_date: string | null;
  };
}
export type CommercialSuggestions = Partial<
  Record<
    keyof CommercialExtraction['fields'],
    { value: string | number; evidence_ids: string[]; validated_at: string }
  >
>;
export interface CommercialJob {
  id: string;
  category: EvidenceCategory;
  status: string;
  evidence_ids: string[];
  attempts: number;
  error: string | null;
  reasons: string[];
  result: CommercialExtraction | null;
}
export interface CommercialSummary {
  enabled: boolean;
  ai_enabled: boolean;
  auto_validate: boolean;
  recipient_check_configured: boolean;
  revision: number;
  can_review: boolean;
  assessment: CommercialAssessment;
  beneficiary_id: string | null;
  evidence: {
    id: string;
    category: EvidenceCategory;
    mime: string;
    status: string;
    url: string;
    reasons?: string[];
    created_at: string;
  }[];
  payments: {
    id: string;
    amount_cents: number;
    paid_on: string;
    status: string;
    evidence_ids: string[];
  }[];
  jobs: CommercialJob[];
  suggestions: CommercialSuggestions;
  validated_at: string | null;
  late_validation: boolean;
  history: { id: string; at: string; action: string; reason: string | null }[];
}
export function uploadCommercialEvidence(
  id: string,
  category: EvidenceCategory,
  file: File,
  key: string,
  onProgress: (value: number) => void,
  signal: AbortSignal,
): Promise<{ evidence_id: string; revision: number; duplicate: boolean }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal.removeEventListener('abort', abort);
    xhr.open(
      'POST',
      `/api/v1/opportunities/${encodeURIComponent(id)}/commercial/evidence?category=${category}`,
    );
    xhr.withCredentials = true;
    xhr.timeout = 90_000;
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.setRequestHeader('X-Artisti-Client', 'web');
    xhr.setRequestHeader('Idempotency-Key', key);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded * 100) / event.total));
    };
    xhr.onload = () => {
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else
          reject(new ApiError(data.message ?? 'Não foi possível enviar.', xhr.status, data.code));
      } catch {
        reject(new Error('Resposta inesperada. Tente reenviar o mesmo arquivo.'));
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      cleanup();
      reject(new Error('Envio interrompido. Reenvie o mesmo arquivo; ele não será duplicado.'));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException('Envio cancelado', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) {
      cleanup();
      reject(new DOMException('Envio cancelado', 'AbortError'));
      return;
    }
    xhr.send(file);
  });
}
