import { z } from "zod";

export const DriverCashTransactionTypeSchema = z.enum(["COLLECTION", "SETTLEMENT", "ADJUSTMENT", "REVERSAL"]);

export const GetDriverCashQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  type: DriverCashTransactionTypeSchema.optional(),
});

export type GetDriverCashQuery = z.infer<typeof GetDriverCashQuerySchema>;
