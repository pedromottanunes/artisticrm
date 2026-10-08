import { z } from 'zod';
import { DomainError, type Opportunity } from './types.js';

export const commercialFields = {
  sale_seller_name: z.string().trim().max(160).optional(),
  consultant: z.string().trim().max(160).optional(),
  total_value_cents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  down_payment_cents: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  total_value_text: z.string().trim().max(160).optional(),
  down_payment_text: z.string().trim().max(160).optional(),
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
    total_value_text: row.total_value_text ?? '',
    down_payment_text: row.down_payment_text ?? '',
    hair_grade_classification: row.hair_grade_classification,
    has_pack: row.has_pack,
    pack_quantity: row.pack_quantity ?? null,
    contract_status: row.contract_status,
    ...Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
  };
  // A cached pre-text client can still send only the numeric representation.
  // In that case, do not retain an unrelated free-text value from a newer edit.
  if (input.total_value_text === undefined && input.total_value_cents !== undefined)
    result.total_value_text = '';
  if (input.down_payment_text === undefined && input.down_payment_cents !== undefined)
    result.down_payment_text = '';
  if (result.has_pack === false) result.pack_quantity = 0;
  if (result.pack_quantity !== null && result.pack_quantity > 0) result.has_pack = true;
  return result;
}

export function assertSaleFinancialValues(values: ReturnType<typeof commercialValues>) {
  if (!values.total_value_text && values.total_value_cents === null)
    throw new DomainError('TOTAL_VALUE_REQUIRED', 'Informe o valor total da venda.', 400);
  if (!values.down_payment_text && values.down_payment_cents === null)
    throw new DomainError('DOWN_PAYMENT_REQUIRED', 'Informe o valor da entrada.', 400);
}
