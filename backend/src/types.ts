export type Role = 'manager' | 'attendant';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  queue_enabled: boolean;
  queue_position: number | null;
  queue_weight: number;
  color: string;
  version: number;
  auth_version: number;
  must_change_password: boolean;
}
export interface Opportunity {
  id: string;
  contact_id: string;
  name: string;
  phone?: string;
  email?: string;
  residence_city?: string;
  instagram?: string;
  profile_picture_url?: string;
  is_demo: boolean;
  interest: string;
  unit: string;
  source: string;
  channel: 'manual' | 'whatsapp' | 'instagram';
  source_evidence: string;
  stage: Stage;
  consultation_status: ConsultationStatus;
  procedure_date: string | Date | null;
  sale_completed_at: string | Date | null;
  sale_seller_name: string;
  consultant: string;
  total_value_cents: number | null;
  down_payment_cents: number | null;
  hair_grade_classification: string;
  has_pack: boolean | null;
  contract_status: ContractStatus | null;
  state: string;
  reserved_to: string | null;
  owner_id: string | null;
  created_at: string | Date;
  expires_at: string | Date | null;
  claimed_at: string | Date | null;
  last_message_at: string | Date;
  next_action: string;
  version: number;
}
export const consultationStatuses = [
  'UNDEFINED',
  'NOT_SCHEDULED',
  'SCHEDULED',
  'ATTENDED',
  'NO_SHOW',
  'CANCELLED',
] as const;
export type ConsultationStatus = (typeof consultationStatuses)[number];
export const contractStatuses = ['awaiting', 'signed', 'not_signed'] as const;
export type ContractStatus = (typeof contractStatuses)[number];
export interface SaleInput {
  expected_version: number;
  name: string;
  phone: string;
  residence_city: string;
  consultant: string;
  total_value_cents: number;
  down_payment_cents: number;
  hair_grade_classification: string;
  has_pack: boolean;
  unit: string;
  procedure_date: string | null;
  contract_status: ContractStatus;
}
export const stages = [
  'NEW_LEAD',
  'CONSULTATION_NOT_SCHEDULED',
  'FOLLOW_UP',
  'CONTRACT_PENDING',
  'CLOSED_WITH_DATE',
  'CLOSED_WITHOUT_DATE',
  'DECLINED',
] as const;
export type Stage = (typeof stages)[number];
export const closedStages = [
  'CONTRACT_PENDING',
  'CLOSED_WITH_DATE',
  'CLOSED_WITHOUT_DATE',
  'DECLINED',
] as const satisfies readonly Stage[];
export const saleStages = [
  'CONTRACT_PENDING',
  'CLOSED_WITH_DATE',
  'CLOSED_WITHOUT_DATE',
] as const satisfies readonly Stage[];
export const stageLabels: Record<Stage, string> = {
  NEW_LEAD: 'Novo lead',
  CONSULTATION_NOT_SCHEDULED: 'Consulta não agendada',
  FOLLOW_UP: 'Em follow-up',
  CONTRACT_PENDING: 'Contrato pendente',
  CLOSED_WITH_DATE: 'Fechado com data',
  CLOSED_WITHOUT_DATE: 'Fechado sem data',
  DECLINED: 'Declinado',
};
const legacyStages: Record<string, Stage> = {
  TO_QUALIFY: 'CONSULTATION_NOT_SCHEDULED',
  EVALUATION_SCHEDULED: 'FOLLOW_UP',
  NEGOTIATION: 'FOLLOW_UP',
  WON: 'CLOSED_WITHOUT_DATE',
  LOST: 'DECLINED',
};
export function normalizeStage(stage: string): Stage | undefined {
  if ((stages as readonly string[]).includes(stage)) return stage as Stage;
  return legacyStages[stage];
}
export const isClosedStage = (stage: string) => (closedStages as readonly string[]).includes(stage);
export const isSaleStage = (stage: string) => (saleStages as readonly string[]).includes(stage);
export function isValidDateOnly(value: string | null | undefined) {
  if (!value || !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === value;
}
export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
  ) {
    super(message);
  }
}
export function requireManager(user: User) {
  if (user.role !== 'manager') throw new DomainError('FORBIDDEN', 'Acesso restrito à gestão.', 403);
}
