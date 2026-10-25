import { prisma } from "../../db/prisma";
import { Prisma } from "../../generated/prisma/client";

// ============================================================
// FR.10.1 — read-only correction eligibility for ledger list views.
//
// Mirrors, row by row, the guards the generic reversal services apply
// (wallet-correction / driver-cash-correction / company-correction) in the
// same order, so a list can tell Finance up front which rows the generic
// endpoint will refuse:
//
//   1. a REVERSAL row can never be reversed                 (400 in every service)
//   2. a row already referenced by reversal_of_id is reversed (409 "already reversed")
//      — set by generic reversals AND by every dedicated correction
//      (collection void, release reversal, settlement reversal)
//   3. wallet PAYOUT rows require their payout to be COMPLETED
//   4. dedicated workflows (409 USE_RELEASE_CORRECTION / USE_SETTLEMENT_CORRECTION):
//        wallet ORDER_CREDIT  ← order_financial_releases.wallet_transaction_id
//        company revenue      ← order_financial_releases.company_product/fee_transaction_id
//        driver COLLECTION    ← order_financial_releases.collection_transaction_id
//        driver SETTLEMENT    ← driver_settlements.allocated_total IS NOT NULL,
//                               or a SETTLEMENT_SHORTFALL correction exists
//        driver ADJUSTMENT    ← driver_settlement_corrections.cash_transaction_id
//
// Never derived from dates, payment methods, amounts or the activation flag.
// Not covered (validated only at processing time, against live state): the
// driver-cash debit cap (amount ≤ unattributed cash) and data-integrity
// failures. The services remain the final authority; the frontend keeps its
// conflict handling for stale reads. Batched: a constant number of queries per
// page, never per row.
// ============================================================

export type CorrectionWorkflow = "GENERIC" | "RELEASE_CORRECTION" | "SETTLEMENT_CORRECTION";

export interface CorrectionEligibility {
  correctionWorkflow: CorrectionWorkflow;
  canReverseGenerically: boolean;
  // A reversal row already references this row (generic or dedicated correction).
  reversed: boolean;
}

type Db = Prisma.TransactionClient | typeof prisma;

function decide(type: string, reversed: boolean, workflow: CorrectionWorkflow, extraBlock = false): CorrectionEligibility {
  return {
    correctionWorkflow: workflow,
    canReverseGenerically: type !== "REVERSAL" && !reversed && workflow === "GENERIC" && !extraBlock,
    reversed,
  };
}

async function reversedIds(
  ids: string[],
  find: (ids: string[]) => Promise<{ reversal_of_id: string | null }[]>
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await find(ids);
  return new Set(rows.map((r) => r.reversal_of_id).filter((v): v is string => v !== null));
}

export async function walletCorrectionEligibility(
  rows: { id: string; type: string; payoutStatus: string | null }[],
  db: Db = prisma
): Promise<Map<string, CorrectionEligibility>> {
  const ids = rows.map((r) => r.id);
  const [reversed, releases] = await Promise.all([
    reversedIds(ids, (i) => db.wallet_transactions.findMany({ where: { reversal_of_id: { in: i } }, select: { reversal_of_id: true } })),
    ids.length === 0
      ? Promise.resolve([])
      : db.order_financial_releases.findMany({ where: { wallet_transaction_id: { in: ids } }, select: { wallet_transaction_id: true } }),
  ]);
  const releaseLinked = new Set(releases.map((r) => r.wallet_transaction_id));
  return new Map(
    rows.map((r) => [
      r.id,
      decide(
        r.type,
        reversed.has(r.id),
        releaseLinked.has(r.id) ? "RELEASE_CORRECTION" : "GENERIC",
        r.type === "PAYOUT" && r.payoutStatus !== "COMPLETED"
      ),
    ])
  );
}

export async function companyCorrectionEligibility(
  rows: { id: string; type: string }[],
  db: Db = prisma
): Promise<Map<string, CorrectionEligibility>> {
  const ids = rows.map((r) => r.id);
  const [reversed, releases] = await Promise.all([
    reversedIds(ids, (i) => db.company_financial_transactions.findMany({ where: { reversal_of_id: { in: i } }, select: { reversal_of_id: true } })),
    ids.length === 0
      ? Promise.resolve([])
      : db.order_financial_releases.findMany({
          where: { OR: [{ company_product_transaction_id: { in: ids } }, { company_fee_transaction_id: { in: ids } }] },
          select: { company_product_transaction_id: true, company_fee_transaction_id: true },
        }),
  ]);
  const releaseLinked = new Set(releases.flatMap((r) => [r.company_product_transaction_id, r.company_fee_transaction_id]));
  return new Map(rows.map((r) => [r.id, decide(r.type, reversed.has(r.id), releaseLinked.has(r.id) ? "RELEASE_CORRECTION" : "GENERIC")]));
}

export async function driverCashCorrectionEligibility(
  rows: { id: string; type: string; settlementId: string | null }[],
  db: Db = prisma
): Promise<Map<string, CorrectionEligibility>> {
  const ids = rows.map((r) => r.id);
  const settlementIds = [...new Set(rows.filter((r) => r.type === "SETTLEMENT" && r.settlementId).map((r) => r.settlementId as string))];
  const [reversed, releases, settlements, shortfalls, correctionRows] = await Promise.all([
    reversedIds(ids, (i) => db.driver_cash_transactions.findMany({ where: { reversal_of_id: { in: i } }, select: { reversal_of_id: true } })),
    ids.length === 0
      ? Promise.resolve([])
      : db.order_financial_releases.findMany({ where: { collection_transaction_id: { in: ids } }, select: { collection_transaction_id: true } }),
    settlementIds.length === 0
      ? Promise.resolve([])
      : db.driver_settlements.findMany({ where: { id: { in: settlementIds } }, select: { id: true, allocated_total: true } }),
    settlementIds.length === 0
      ? Promise.resolve([])
      : db.driver_settlement_corrections.findMany({
          where: { settlement_id: { in: settlementIds }, correction_type: "SETTLEMENT_SHORTFALL" },
          select: { settlement_id: true },
        }),
    ids.length === 0
      ? Promise.resolve([])
      : db.driver_settlement_corrections.findMany({ where: { cash_transaction_id: { in: ids } }, select: { cash_transaction_id: true } }),
  ]);
  const releaseLinked = new Set(releases.map((r) => r.collection_transaction_id));
  const allocationFormat = new Set(settlements.filter((s) => s.allocated_total !== null).map((s) => s.id));
  const withShortfall = new Set(shortfalls.map((s) => s.settlement_id));
  const correctionCash = new Set(correctionRows.map((c) => c.cash_transaction_id));

  return new Map(
    rows.map((r) => {
      let workflow: CorrectionWorkflow = "GENERIC";
      if (r.type === "COLLECTION" && releaseLinked.has(r.id)) workflow = "RELEASE_CORRECTION";
      else if (r.type === "SETTLEMENT" && r.settlementId && (allocationFormat.has(r.settlementId) || withShortfall.has(r.settlementId))) {
        workflow = "SETTLEMENT_CORRECTION";
      } else if (r.type === "ADJUSTMENT" && correctionCash.has(r.id)) workflow = "SETTLEMENT_CORRECTION";
      return [r.id, decide(r.type, reversed.has(r.id), workflow)];
    })
  );
}
