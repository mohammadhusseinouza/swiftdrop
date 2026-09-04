import { z } from 'zod';

import type { CreatePayoutRequest } from '../../../services/payoutsApi';
import { parseMoneyToCents } from '../../../lib/money';

/**
 * Frontend Process Payout validation — mirrors the live backend contract
 * (server/src/modules/payouts/payout.schema.ts `CreatePayoutBodySchema` +
 * the `positiveMoneySchema` refinement).
 *
 * UX validation only. The backend re-validates every field, re-checks the
 * available wallet balance atomically inside the payout transaction, and owns
 * every server-derived value (payoutNumber, status, processedById, walletId,
 * balanceBefore/After, the idempotency key). Those are never in this schema or
 * the request body.
 *
 * The `amount <= availableBalance` rule is enforced in the dialog against the
 * authoritative server balance using exact-cents comparison — not here, because
 * the balance is fetched asynchronously.
 */

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

export const processPayoutSchema = z.object({
  customerId: z
    .string()
    .min(1, 'Select a customer')
    .pipe(z.uuid('Select a customer')),
  amount: z
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

export type ProcessPayoutFormValues = z.infer<typeof processPayoutSchema>;

export function makeProcessPayoutDefaults(
  customerId = '',
): ProcessPayoutFormValues {
  return { customerId, amount: '', paymentMethodId: '', notes: '' };
}

/** Build the exact POST /api/v1/payouts body. `notes` is omitted when blank. */
export function toCreatePayoutRequest(
  values: ProcessPayoutFormValues,
): CreatePayoutRequest {
  const notes = values.notes.trim();
  return {
    customerId: values.customerId,
    amount: values.amount.trim(),
    paymentMethodId: values.paymentMethodId,
    ...(notes === '' ? {} : { notes }),
  };
}

/** Fields the backend VALIDATION_ERROR tree can map back onto the form. */
export const PROCESS_PAYOUT_FIELDS = new Set<keyof ProcessPayoutFormValues>([
  'customerId',
  'amount',
  'paymentMethodId',
  'notes',
]);
