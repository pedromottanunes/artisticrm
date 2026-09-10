export type Role = 'manager' | 'attendant';
export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  queue_enabled: boolean;
  queue_position: number | null;
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
  created_at: string | Date;
  expires_at: string | Date | null;
  claimed_at: string | Date | null;
  last_message_at: string | Date;
  next_action: string;
  version: number;
}
export const stages = [
  'TO_QUALIFY',
  'EVALUATION_SCHEDULED',
  'NEGOTIATION',
  'CONTRACT_PENDING',
  'WON',
  'LOST',
] as const;
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
