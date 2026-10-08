import { z } from 'zod';
import { DomainError, type Opportunity } from './types.js';

export const commercialFields = {
  sale_seller_name: z.string().trim().max(160).optional(),
  consultant: z.string().trim().max(160).optional(),
  total_value_cents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  down_payment_cents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  hair_grade_classification: z.string().trim().max(160).optional(),
  has_pack: z.boolean().nullable().optional(),
  pack_quantity: z.number().int().min(0).max(10000).nullable().optional(),
  contract_status: z.enum(['awaiting', 'signed', 'not_signed']).nullable().optional(),
};
export const commercialSchema = z.object(commercialFields).strict();
export type CommercialInput = z.infer<typeof commercialSchema>;

// Omitted fields from older clients remain unchanged; explicit null clears a draft value.
export function commercialValues(row: Opportunity, input: CommercialInput) {
  const changes = commercialSchema.parse(
    Object.fromEntries(
      Object.keys(commercialFields).map((key) => [key, input[key as keyof CommercialInput]]),
    ),
  );
  const result = {
    sale_seller_name: row.sale_seller_name,
    consultant: row.consultant,
    total_value_cents: row.total_value_cents,
    down_payment_cents: row.down_payment_cents,
    hair_grade_classification: row.hair_grade_classification,
    has_pack: row.has_pack,
    pack_quantity: row.pack_quantity ?? null,
    contract_status: row.contract_status,
    ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
  };
  if (
    result.total_value_cents !== null &&
    result.down_payment_cents !== null &&
    result.down_payment_cents > result.total_value_cents
  )
    throw new DomainError(
      'INVALID_DOWN_PAYMENT',
      'O valor da entrada não pode superar o valor total.',
      400,
    );
  if (result.has_pack === false) result.pack_quantity = 0;
  if (result.pack_quantity !== null && result.pack_quantity > 0) result.has_pack = true;
  return result;
}
