import { z } from "zod";
import { dateOnlySchema, fromNotAfterTo } from "../../shared/date/date-range.schema";
import { LEDGER_VALUES, type LedgerName } from "./finance-read.types";

// GET /api/v1/finance/summary — from/to are both optional; no page/limit
// (a single computed summary, never a list).
export const FinanceDateRangeQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type FinanceDateRangeQuery = z.infer<typeof FinanceDateRangeQuerySchema>;

// The real transaction-type strings that exist across the three ledger
// enums (prisma/schema.prisma: WalletTransactionType, DriverCashTransactionType,
// CompanyFinancialTransactionType) — kept here as plain string literals
// rather than importing the generated Prisma enums, since this is a request-
// validation whitelist, not a Prisma query.
const WALLET_TYPES = ["ORDER_CREDIT", "PAYOUT", "ADJUSTMENT", "REVERSAL"] as const;
const DRIVER_CASH_TYPES = ["COLLECTION", "SETTLEMENT", "ADJUSTMENT", "REVERSAL"] as const;
const COMPANY_TYPES = ["DELIVERY_FEE_REVENUE", "COMPANY_ORDER_PRODUCT_REVENUE", "ADJUSTMENT", "REVERSAL"] as const;

const TYPES_BY_LEDGER: Record<LedgerName, readonly string[]> = {
  WALLET: WALLET_TYPES,
  DRIVER_CASH: DRIVER_CASH_TYPES,
  COMPANY_FINANCE: COMPANY_TYPES,
};

const ALL_TRANSACTION_TYPES = Array.from(new Set<string>([...WALLET_TYPES, ...DRIVER_CASH_TYPES, ...COMPANY_TYPES]));

// GET /api/v1/finance/transactions
export const FinanceTransactionsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    ledger: z.enum(LEDGER_VALUES).optional(),
    type: z.string().optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] })
  .superRefine((data, ctx) => {
    if (!data.type) return;
    if (!ALL_TRANSACTION_TYPES.includes(data.type)) {
      ctx.addIssue({ code: "custom", message: "type is not a recognized ledger transaction type", path: ["type"] });
      return;
    }
    if (data.ledger && !TYPES_BY_LEDGER[data.ledger].includes(data.type)) {
      ctx.addIssue({ code: "custom", message: "type is not a valid transaction type for the specified ledger", path: ["type"] });
    }
  });

export type FinanceTransactionsQuery = z.infer<typeof FinanceTransactionsQuerySchema>;
