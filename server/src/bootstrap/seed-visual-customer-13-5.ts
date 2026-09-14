import "../config/load-env";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../app";
import { prisma } from "../db/prisma";

/**
 * DEVELOPMENT-ONLY visual acceptance data for Customer Wallet Transactions
 * (Phase 13.5). Run AFTER seed:visual (+ 13-1..13-3):
 *   npm run seed:visual:customer-13-5
 *
 * customer@swiftdrop.test already has an ORDER_CREDIT row (a real Phase 8.3
 * delivery credit). This adds the other three ledger shapes via approved
 * Finance workflows:
 *   - ADJUSTMENT (credit +50)
 *   - REVERSAL   (of that adjustment, -50)
 *   - PAYOUT     (-40, POST /api/v1/payouts)
 *
 * SAFETY: refuses NODE_ENV=production; only touches *@swiftdrop.test fixtures
 * + rows tagged "PH135-VIS"; idempotent (tag-detected); NO schema change /
 * migration / manual ledger-row fabrication.
 */

const PASSWORD = "VisualTest123!";
const TAG = "PH135-VIS";
type App = ReturnType<typeof createApp>;

async function login(app: App, email: string): Promise<string> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200 || !res.body?.data?.accessToken) {
    throw new Error(`[seed:visual:customer-13-5] login failed for ${email} (status ${res.status}).`);
  }
  return res.body.data.accessToken as string;
}
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function main(): Promise<void> {
  if ((process.env.NODE_ENV ?? "development") === "production") {
    console.error("[seed:visual:customer-13-5] Refusing to run with NODE_ENV=production.");
    process.exitCode = 1;
    return;
  }
  const app = createApp();

  const customerUser = await prisma.users.findUnique({ where: { email: "customer@swiftdrop.test" }, select: { id: true } });
  if (!customerUser) throw new Error('[seed:visual:customer-13-5] customer@swiftdrop.test not found — run "npm run seed:visual" first.');
  const customer = await prisma.customers.findUniqueOrThrow({ where: { portal_user_id: customerUser.id } });

  const tagged = await prisma.wallet_transactions.findFirst({
    where: { customer_id: customer.id, notes: { contains: TAG } },
    select: { id: true },
  });
  if (tagged) {
    console.log("[seed:visual:customer-13-5] PH135-VIS ledger rows already present — skipping.");
  } else {
    const adminToken = await login(app, "admin@swiftdrop.test");
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });

    const post = (url: string, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) =>
      request(app).post(url).set(bearer(adminToken)).set(extraHeaders).send(body);
    async function ok(p: request.Test, label: string) {
      const res = await p;
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`[seed:visual:customer-13-5] ${label} failed (${res.status}): ${JSON.stringify(res.body)}`);
      }
      return res;
    }

    // ADJUSTMENT credit +50.
    const adj = await ok(
      post(`/api/v1/wallets/${customer.id}/adjust`, {
        direction: "CREDIT",
        amount: "50.00",
        reason: `${TAG} visual goodwill credit`,
      }),
      "adjustment"
    );
    // REVERSAL of that adjustment (-50).
    await ok(
      post(`/api/v1/wallet-transactions/${adj.body.data.id}/reverse`, { reason: `${TAG} visual reversal` }),
      "reversal"
    );
    // PAYOUT -40 (approved Finance workflow, Idempotency-Key required).
    await ok(
      post(
        `/api/v1/payouts`,
        { customerId: customer.id, amount: "40.00", paymentMethodId: cashMethod.id, notes: `${TAG} visual payout` },
        { "Idempotency-Key": randomUUID() }
      ),
      "payout"
    );

    console.log("[seed:visual:customer-13-5] PH135-VIS ledger rows created.");
  }

  const customerToken = await login(app, "customer@swiftdrop.test");
  const txs = await request(app)
    .get("/api/v1/customer/me/wallet/transactions?limit=50")
    .set(bearer(customerToken));
  const byType = (txs.body?.data ?? []).reduce((acc: Record<string, number>, t: { type: string }) => {
    acc[t.type] = (acc[t.type] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`[seed:visual:customer-13-5] Done. Ledger rows by type: ${JSON.stringify(byType)}`);
}

main()
  .catch((error) => {
    console.error("[seed:visual:customer-13-5] Failed.");
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
