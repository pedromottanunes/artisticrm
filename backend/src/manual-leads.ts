import { DomainError, type Opportunity } from './types.js';

// Manual entry is not a claim/transfer action. Never expose another consultant's lead,
// including when replaying a receipt after management has transferred the lead.
export function assertManualLeadAccess(
  ownerId: string,
  lead: Pick<Opportunity, 'owner_id' | 'state' | 'stage'> | null | undefined,
) {
  if (!lead || lead.owner_id !== ownerId || lead.state !== 'CLAIMED')
    throw new DomainError(
      'LEAD_EXISTS',
      'Este telefone já possui cadastro no CRM. Use o atendimento existente ou solicite revisão à gestão.',
      409,
    );
}
