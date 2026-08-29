import { z } from "zod";

export const WalletCustomerIdParamSchema = z.object({
  customerId: z.string().uuid(),
});

export const ListWalletsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
});

export type ListWalletsQuery = z.infer<typeof ListWalletsQuerySchema>;

// GET /api/v1/wallets/customer-summaries?customerIds=uuid,uuid,...
// Batched wallet balance + pending for a page of Customers — the
// wallets.read-gated financial source for the Management Customer List
// (Phase 11.6 correction). Comma-separated UUID list, bounded to one page.
export const WalletCustomerSummariesQuerySchema = z.object({
  customerIds: z
    .string()
    .trim()
    .min(1, "customerIds is required")
    .transform((raw) => raw.split(",").map((s) => s.trim()).filter(Boolean))
    .pipe(
      z
        .array(z.string().uuid("Each customerId must be a UUID"))
        .min(1, "At least one customerId is required")
        .max(100, "At most 100 customerIds per request")
    ),
});

export type WalletCustomerSummariesQuery = z.infer<typeof WalletCustomerSummariesQuerySchema>;

export const WalletTransactionTypeSchema = z.enum(["ORDER_CREDIT", "PAYOUT", "ADJUSTMENT", "REVERSAL"]);

export const ListWalletTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  type: WalletTransactionTypeSchema.optional(),
});

export type ListWalletTransactionsQuery = z.infer<typeof ListWalletTransactionsQuerySchema>;
