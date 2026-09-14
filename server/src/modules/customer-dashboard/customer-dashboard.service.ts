import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerProfileForUser } from "../auth/ownership.service";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import { getCustomerWalletFigures } from "../wallets/wallet.service";
import type { CustomerDashboardSummary } from "./customer-dashboard.types";

// ============================================================
// GET /api/v1/customer/me/dashboard (Phase 13.1)
//
// SELF-SCOPED, READ-ONLY. The Customer is resolved ONLY from
// req.actor.userId (passed in as `userId`) via getCustomerProfileForUser —
// there is no code path that reads a customerId from query/params/body, so a
// `?customerId=<other>` spoof has no effect (identical discipline to
// tracking.service.ts / driver-job.service.ts).
//
// Every statement below is a plain SELECT/aggregate/count — this module must
// never write (task §20/§54).
//
// FINANCIAL FIGURES REUSE THE APPROVED HELPERS, NEVER A SECOND DEFINITION:
//   availableWalletBalance -> customer_wallets.available_balance (Phase 8.2
//                             authoritative wallet balance)
//   pendingAmount          -> getPendingAmountForCustomer (the approved
//                             Phase 8.2 pending rule: SUM(remaining_order_amount)
//                             over active DELIVERY_ONLY orders; COMPANY_ORDER,
//                             the delivery fee, terminal orders and DELIVERED
//                             orders are all excluded by that helper)
//   activeOrders           -> ORDER_ACTIVE_STATUSES (the single shared
//                             non-terminal lifecycle set — FAILED_DELIVERY and
//                             RESCHEDULED are active/retryable per the Order
//                             engine; DELIVERED/CANCELLED/RETURNED_* are not)
//   deliveredOrders        -> status = DELIVERED (a delivered COMPANY_ORDER
//                             still counts here even though it credits no
//                             wallet — task §17)
//
// REVIEW_REQUIRED (task §15): a DELIVERED order with a collection difference
// carries financial_status = REVIEW_REQUIRED until Management resolves it.
// It is counted in deliveredOrders (its status is DELIVERED) and NOT in
// activeOrders. It contributes to neither availableWalletBalance (the wallet
// is only credited when the difference is resolved) nor pendingAmount (the
// pending helper excludes every non-active status, DELIVERED included). This
// is the existing approved behavior, reused verbatim — no new metric, and
// none of the review internals are exposed.
// ============================================================

export async function getCustomerDashboardSummary(userId: string): Promise<CustomerDashboardSummary> {
  const customer = await getCustomerProfileForUser(userId);

  const [figures, customerRow, activeOrders, deliveredOrders] = await Promise.all([
    // Shared authoritative wallet figures — the SAME helper /customer/wallet
    // uses, so the two pages can never disagree (Phase 13.4). Also raises the
    // data-integrity 500 for a missing wallet row.
    getCustomerWalletFigures(customer.id),
    prisma.customers.findUnique({
      where: { id: customer.id },
      select: { name: true, customer_number: true },
    }),
    prisma.orders.count({
      where: { customer_id: customer.id, status: { in: [...ORDER_ACTIVE_STATUSES] } },
    }),
    prisma.orders.count({
      where: { customer_id: customer.id, status: "DELIVERED" },
    }),
  ]);

  // getCustomerProfileForUser already resolved the Customer — a null row here
  // would be a concurrent delete; fail closed rather than emit a partial DTO.
  if (!customerRow) {
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer record is missing" });
  }

  return {
    customer: { name: customerRow.name, customerNumber: customerRow.customer_number },
    availableWalletBalance: figures.availableBalance,
    pendingAmount: figures.pendingAmount,
    activeOrders,
    deliveredOrders,
  };
}
