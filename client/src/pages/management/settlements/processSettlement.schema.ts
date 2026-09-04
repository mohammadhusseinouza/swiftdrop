import { z } from 'zod';

import type { CreateSettlementRequest } from '../../../services/settlementsApi';
import { parseMoneyToCents } from '../../../lib/money';

/**
 * Frontend Process Settlement validation — mirrors the live backend contract
 * (server/src/modules/settlements/settlement.schema.ts `CreateSettlementBodySchema`
 * + the `positiveMoneySchema` refinement).
 *
 * UX validation only. The backend re-validates every field, re-checks the
 * driver's cash balance atomically inside the settlement transaction
 * (`debitDriverSettlement`), and owns every server-derived value
 * (settlementNumber, balanceBefore/After, receivedById, cashAccountId,
 * transaction id, the idempotency key). Those are never in this schema or the
 * request body.
 *
 * The `amountReceived <= currentCashHeld` rule is enforced in the dialog
 * against the authoritative server balance using exact-cents comparison — not
 * here, because the balance is fetched asynchronously.
 */

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export const processSettlementSchema = z.object({
  driverId: z
    .string()
    .min(1, 'Select a driver')
    .pipe(z.uuid('Select a driver')),
  amountReceived: z
    .string()
    .trim()
    .min(1, 'Enter an amount')
    .regex(MONEY_RE, 'Enter an amount with at most 2 decimals')
    .refine((v) => {
      const cents = parseMoneyToCents(v);
      return cents !== null && cents > 0n;
    }, 'Amount must be greater than zero'),
  paymentMethodId: z
    .string()
    .min(1, 'Select a payment method')
    .pipe(z.uuid('Select a payment method')),
  notes: z.string().trim().max(2000, 'At most 2000 characters'),
});

export type ProcessSettlementFormValues = z.infer<typeof processSettlementSchema>;

export function makeProcessSettlementDefaults(
  driverId = '',
): ProcessSettlementFormValues {
  return { driverId, amountReceived: '', paymentMethodId: '', notes: '' };
}

/** Build the exact POST /api/v1/driver-settlements body. `notes` omitted when blank. */
export function toCreateSettlementRequest(
  values: ProcessSettlementFormValues,
): CreateSettlementRequest {
  const notes = values.notes.trim();
  return {
    driverId: values.driverId,
    amountReceived: values.amountReceived.trim(),
    paymentMethodId: values.paymentMethodId,
    ...(notes === '' ? {} : { notes }),
  };
}

/** Fields the backend VALIDATION_ERROR tree can map back onto the form. */
export const PROCESS_SETTLEMENT_FIELDS = new Set<
  keyof ProcessSettlementFormValues
>(['driverId', 'amountReceived', 'paymentMethodId', 'notes']);
