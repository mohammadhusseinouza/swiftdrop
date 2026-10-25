import { Prisma } from "../generated/prisma/client";
import { prisma } from "./prisma";

// Runs several reads against ONE consistent database snapshot (REPEATABLE
// READ) in a READ ONLY transaction (Settlement-Based Financial Release FR.7).
// Used where figures shown together must agree — e.g. a wallet's available
// balance and its pending-settlement amount: a release moves money from one
// to the other in a single transaction, so two independent reads could
// briefly count it twice or not at all. READ ONLY makes any accidental
// write fail instead of committing.
export async function readSnapshot<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return fn(tx);
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}
