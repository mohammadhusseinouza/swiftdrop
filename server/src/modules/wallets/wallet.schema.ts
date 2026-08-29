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

export const WalletTransactionTypeSchema = z.enum(["ORDER_CREDIT", "PAYOUT", "ADJUSTMENT", "REVERSAL"]);

export const ListWalletTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  type: WalletTransactionTypeSchema.optional(),
});

export type ListWalletTransactionsQuery = z.infer<typeof ListWalletTransactionsQuerySchema>;
