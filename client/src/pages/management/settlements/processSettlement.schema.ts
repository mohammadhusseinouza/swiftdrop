import { z } from 'zod';

import type { CreateSettlementRequest } from '../../../services/settlementsApi';
import { compareMoney, parseMoneyToCents } from '../../../lib/money';

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
 * FR.9: the form serves two request formats. The typed `amountReceived` is
 * used only by the LEGACY format (validated by `legacyAmountError` against
 * the authoritative server cash position); the ALLOCATION format computes
 * amountReceived from the allocations + unattributed amount
 * (settlementAllocation.ts), so the field is not schema-required here.
 */

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export const processSettlementSchema = z.object({
  driverId: z
    .string()
    .min(1, 'Select a driver')
    .pipe(z.uuid('Select a driver')),
  amountReceived: z.string().trim(),
  paymentMethodId: z
    .string()
    .min(1, 'Select a payment method')
    .pipe(z.uuid('Select a payment method')),
  notes: z.string().trim().max(2000, 'At most 2000 characters'),
});

export type ProcessSettlementFormValues = z.infer<typeof processSettlementSchema>;

/**
 * Legacy-format amount rules: required, ≤2 decimals, > 0, and ≤ the cash the
 * driver currently holds (exact cents). null when valid.
 */
export function legacyAmountError(amount: string, cashHeld: string | null): string | null {
  const value = amount.trim();
  if (value === '') return 'Enter an amount';
  if (!MONEY_RE.test(value)) return 'Enter an amount with at most 2 decimals';
  const cents = parseMoneyToCents(value);
  if (cents === null || cents <= 0n) return 'Amount must be greater than zero';
  if (cashHeld !== null && compareMoney(value, cashHeld) === 1) return 'Amount exceeds the cash held';
  return null;
}

export function makeProcessSettlementDefaults(
  driverId = '',
): ProcessSettlementFormValues {
  return { driverId, amountReceived: '', paymentMethodId: '', notes: '' };
}

/** Build the exact LEGACY-format POST /api/v1/driver-settlements body (no allocations). */
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
