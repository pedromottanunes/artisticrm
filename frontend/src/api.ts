export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
  ) {
    super(message);
  }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Artisti-Client': 'web', ...options.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new ApiError(data.message ?? 'Não foi possível concluir.', response.status, data.code);
  return data;
}
export interface User {
  id: string;
  name: string;
  email: string;
  role: 'manager' | 'attendant';
  active: boolean;
  queue_enabled: boolean;
  queue_position: number | null;
  queue_weight: number;
  color: string;
  version: number;
  must_change_password: boolean;
}
export interface Lead {
  needs_review: boolean;
  id: string;
  name: string;
  phone?: string;
  email?: string;
  instagram?: string;
  is_demo: boolean;
  interest: string;
  unit: string;
  source: string;
  channel: 'manual' | 'whatsapp' | 'instagram';
  source_evidence: string;
  stage: string;
  procedure_date: string | null;
  state: string;
  reserved_to: string | null;
  owner_id: string | null;
  created_at: string;
  expires_at: string | null;
  claimed_at: string | null;
  next_action: string;
  version: number;
}
export interface Detail extends Lead {
  appointments: Appointment[];
  can_edit: boolean;
  history: { id: string; kind: string; description: string; created_at: string }[];
  attributions: MetaAttribution[];
}
export interface MetaAttribution {
  id: string;
  provider: 'meta';
  channel: 'whatsapp' | 'instagram';
  source_type: 'ad';
  source_id?: string | null;
  source_url?: string | null;
  headline?: string | null;
  body?: string | null;
  media_type?: string | null;
  image_url?: string | null;
  video_url?: string | null;
  thumbnail_url?: string | null;
  received_at: string;
}
export interface ConversationSummary {
  id: string;
  opportunity_id: string;
  contact_name: string;
  instagram_username: string;
  state: string;
  owner_id: string | null;
  reserved_to: string | null;
  last_message_at: string;
  can_send: boolean;
}
export interface ConversationMessage {
  id: string;
  external_message_id?: string | null;
  direction: 'inbound' | 'outbound';
  sender_user_id?: string | null;
  type: string;
  text: string;
  attachments: { type: string; url?: string }[];
  status: 'received' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';
  error_code?: string | null;
  sent_at?: string | null;
  delivered_at?: string | null;
  read_at?: string | null;
  created_at: string;
}
export interface Appointment {
  version: number;
  id: string;
  opportunity_id: string;
  name: string;
  starts_at: string;
  unit: string;
  status: string;
  owner_id: string | null;
}
export interface Snapshot {
  user: User;
  users: User[];
  opportunities: Lead[];
  appointments: Appointment[];
  settings: { version: number; timeout_minutes: number; last_position: number };
  server_time: string;
  demo: boolean;
  limit: number;
}
export const stages: Record<string, string> = {
  CONSULTATION_NOT_SCHEDULED: 'Consulta não agendada',
  FOLLOW_UP: 'Em follow-up',
  CONTRACT_PENDING: 'Contrato pendente',
  CLOSED_WITH_DATE: 'Fechado com data',
  CLOSED_WITHOUT_DATE: 'Fechado sem data',
  DECLINED: 'Declinado',
};
export const closedStages = [
  'CONTRACT_PENDING',
  'CLOSED_WITH_DATE',
  'CLOSED_WITHOUT_DATE',
  'DECLINED',
] as const;
export const isClosedStage = (stage: string) => (closedStages as readonly string[]).includes(stage);
export const stateLabels: Record<string, string> = {
  RESERVED: 'Nova reserva',
  POOL: 'No bolsão',
  CLAIMED: 'Em atendimento',
  PENDING: 'Sem atendente',
  CANCELLED: 'Encerrado',
};
