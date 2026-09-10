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
  source_evidence: string;
  stage: string;
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
  TO_QUALIFY: 'A qualificar',
  EVALUATION_SCHEDULED: 'Avaliação agendada',
  NEGOTIATION: 'Em negociação',
  CONTRACT_PENDING: 'Contrato pendente',
  WON: 'Conquistados',
  LOST: 'Não avançaram',
};
export const stateLabels: Record<string, string> = {
  RESERVED: 'Nova reserva',
  POOL: 'No bolsão',
  CLAIMED: 'Em atendimento',
  PENDING: 'Sem atendente',
  CANCELLED: 'Encerrado',
};
