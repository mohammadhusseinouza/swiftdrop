import { randomBytes } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { prisma } from "../../src/db/prisma";
import { hashPassword } from "../../src/modules/auth/auth.utils";
import { Prisma } from "../../src/generated/prisma/client";
import type { OrderFinancialStatus, OrderStatus, OrderType, PaymentType } from "../../src/generated/prisma/client";

export const TEST_PASSWORD = "Phase45-Test-Pw!";
const TEST_EMAIL_DOMAIN = "phase4-5-test.swiftdrop.local";

export function uniqueSuffix(): string {
  return randomBytes(6).toString("hex");
}

export function uniqueEmail(label: string): string {
  return `${label}-${uniqueSuffix()}@${TEST_EMAIL_DOMAIN}`;
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  roleCode: string;
}

export async function createTestUser(roleCode: string, opts: { isActive?: boolean } = {}): Promise<TestUser> {
  const role = await prisma.roles.findUniqueOrThrow({ where: { code: roleCode } });
  const email = uniqueEmail(roleCode.toLowerCase());
  const passwordHash = await hashPassword(TEST_PASSWORD);

  const user = await prisma.users.create({
    data: {
      email,
      password_hash: passwordHash,
      first_name: "Phase45",
      last_name: roleCode,
      role_id: role.id,
      is_active: opts.isActive ?? true,
    },
  });

  return { id: user.id, email, password: TEST_PASSWORD, roleCode };
}

export async function createTestEmployee(userId: string): Promise<string> {
  const employee = await prisma.employees.create({
    data: { user_id: userId, employee_number: `PH45-EMP-${uniqueSuffix()}` },
  });
  return employee.id;
}

export async function createTestDriver(userId: string): Promise<string> {
  const driver = await prisma.drivers.create({
    data: { user_id: userId, driver_number: `PH45-DRV-${uniqueSuffix()}` },
  });
  return driver.id;
}

export async function createTestCustomer(userId: string, createdByUserId: string): Promise<string> {
  const customer = await prisma.customers.create({
    data: {
      portal_user_id: userId,
      customer_number: `PH45-CUST-${uniqueSuffix()}`,
      name: `Phase45 Test Customer ${uniqueSuffix()}`,
      primary_phone: "+10000000000",
      created_by_id: createdByUserId,
    },
  });
  return customer.id;
}

export async function setUserActive(userId: string, isActive: boolean): Promise<void> {
  await prisma.users.update({ where: { id: userId }, data: { is_active: isActive } });
}

export async function createTestArea(): Promise<{ id: string; name: string }> {
  const area = await prisma.areas.create({
    data: { name: `Phase51 Test Area ${uniqueSuffix()}` },
  });
  return { id: area.id, name: area.name };
}

export async function cleanupTestArea(areaId: string): Promise<void> {
  await prisma.areas.deleteMany({ where: { id: areaId } });
}

export interface SeededCustomerOverrides {
  customerNumber?: string;
  name?: string;
  primaryPhone?: string;
  email?: string;
  isActive?: boolean;
  areaId?: string;
  portalUserId?: string;
  createdAt?: Date;
}

// Directly seeds a customer row (+ its required wallet), bypassing the HTTP
// API — used for list/search/filter/ordering fixtures where the point is
// the query behavior, not the create endpoint itself.
export async function seedCustomerRecord(
  createdByUserId: string,
  overrides: SeededCustomerOverrides = {}
): Promise<string> {
  const suffix = uniqueSuffix();
  const customer = await prisma.customers.create({
    data: {
      customer_number: overrides.customerNumber ?? `PH51-CUST-${suffix}`,
      name: overrides.name ?? `Phase51 Test Customer ${suffix}`,
      primary_phone: overrides.primaryPhone ?? "+10000000000",
      email: overrides.email,
      is_active: overrides.isActive ?? true,
      default_area_id: overrides.areaId,
      portal_user_id: overrides.portalUserId,
      created_by_id: createdByUserId,
      ...(overrides.createdAt ? { created_at: overrides.createdAt } : {}),
    },
  });

  await prisma.customer_wallets.create({ data: { customer_id: customer.id } });

  return customer.id;
}

// Removes a customer row and its dependent wallet/payout rows only — never
// touches unrelated customers/wallets/payouts.
export async function cleanupTestCustomerRecord(customerId: string): Promise<void> {
  // FK order matters (Postgres default is RESTRICT, no cascade overrides):
  // wallet_transactions.payout_id -> customer_payouts.id, so
  // wallet_transactions must be cleared before customer_payouts; both must
  // be cleared before customer_wallets/customers themselves. A single
  // deleteMany on wallet_transactions here also clears any self-referencing
  // reversal_of_id pairs for this customer together.
  //
  // Wrapped in one transaction so a CONCURRENT test file's `GET /wallets`
  // (which throws 500 if a customer on the page has no wallet row) can never
  // observe the intermediate "customer exists, wallet already deleted" state.
  await prisma.$transaction([
    prisma.wallet_transactions.deleteMany({ where: { customer_id: customerId } }),
    // Phase 8.5 is the first suite to create real customer_payouts rows.
    prisma.customer_payouts.deleteMany({ where: { customer_id: customerId } }),
    prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } }),
    prisma.customers.deleteMany({ where: { id: customerId } }),
    // Phase 11.6 correction — customer mutations now emit CUSTOMER audit rows
    // (polymorphic entity_type/entity_id, no FK) — clear them or they orphan.
    prisma.audit_logs.deleteMany({ where: { entity_type: "CUSTOMER", entity_id: customerId } }),
  ]);
}

export interface SeededDriverOverrides {
  driverNumber?: string;
  isActive?: boolean;
  createdAt?: Date;
}

// Directly seeds a driver row (+ its required cash account) for a given
// user, bypassing the HTTP API — used for list/search/filter/ordering
// fixtures where the point is the query behavior, not the create endpoint.
export async function seedDriverRecord(userId: string, overrides: SeededDriverOverrides = {}): Promise<string> {
  const driver = await prisma.drivers.create({
    data: {
      user_id: userId,
      driver_number: overrides.driverNumber ?? `PH52-DRV-${uniqueSuffix()}`,
      is_active: overrides.isActive ?? true,
      ...(overrides.createdAt ? { created_at: overrides.createdAt } : {}),
    },
  });

  await prisma.driver_cash_accounts.create({ data: { driver_id: driver.id } });

  return driver.id;
}

// Removes a driver row and its dependent cash account/settlement rows only
// (all ON DELETE RESTRICT) — never touches unrelated drivers/cash
// accounts/settlements.
export async function cleanupTestDriverRecord(driverId: string): Promise<void> {
  // FK order matters (Postgres default is RESTRICT, no cascade overrides):
  // driver_cash_transactions.settlement_id -> driver_settlements.id, so
  // driver_cash_transactions must be cleared before driver_settlements;
  // both must be cleared before driver_cash_accounts/drivers themselves.
  await prisma.driver_cash_transactions.deleteMany({ where: { driver_id: driverId } });
  // Phase 8.6 is the first suite to create real driver_settlements rows.
  await prisma.driver_settlements.deleteMany({ where: { driver_id: driverId } });
  await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driverId } });
  await prisma.drivers.deleteMany({ where: { id: driverId } });
  // Phase 11.7 correction — driver mutations now emit DRIVER audit rows
  // (polymorphic entity_type/entity_id, no FK) — clear them or they orphan.
  await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER", entity_id: driverId } });
}

// Deletes every row this suite may have created for a given user, in
// FK-safe order. Safe to call even if some rows were never created.
export async function cleanupTestUser(userId: string): Promise<void> {
  await prisma.auth_sessions.deleteMany({ where: { user_id: userId } });
  await prisma.customers.deleteMany({ where: { portal_user_id: userId } });
  const driver = await prisma.drivers.findUnique({ where: { user_id: userId } });
  if (driver) {
    await prisma.driver_cash_transactions.deleteMany({ where: { driver_id: driver.id } });
    await prisma.driver_settlements.deleteMany({ where: { driver_id: driver.id } });
    await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.id } });
    await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER", entity_id: driver.id } });
  }
  await prisma.drivers.deleteMany({ where: { user_id: userId } });
  await prisma.employees.deleteMany({ where: { user_id: userId } });
  // Phase 11.7 correction — a driver create/update audit row references the
  // acting management user; clear this user's authored audit rows too.
  await prisma.audit_logs.deleteMany({ where: { actor_user_id: userId } });
  await prisma.users.deleteMany({ where: { id: userId } });
}

export interface LoginResult {
  status: number;
  accessToken?: string;
  refreshCookie?: string;
  setCookieHeader?: string;
  body: unknown;
}

export function extractCookieValue(setCookieHeaders: string[] | undefined, cookieName: string): string | undefined {
  if (!setCookieHeaders) return undefined;
  for (const header of setCookieHeaders) {
    const [pair] = header.split(";");
    const [name, value] = pair.split("=");
    if (name === cookieName) {
      return value;
    }
  }
  return undefined;
}

export async function loginTestUser(app: Express, email: string, password: string): Promise<LoginResult> {
  const res = await request(app).post("/api/v1/auth/login").send({ email, password });
  const setCookie = res.headers["set-cookie"] as unknown as string[] | undefined;

  return {
    status: res.status,
    accessToken: res.body?.data?.accessToken,
    refreshCookie: extractCookieValue(setCookie, "refresh_token"),
    setCookieHeader: setCookie?.find((c) => c.startsWith("refresh_token=")),
    body: res.body,
  };
}

// ===== Phase 5.3 — Reference / Settings Data =====

export async function cleanupTestPaymentMethod(id: string): Promise<void> {
  await prisma.payment_methods.deleteMany({ where: { id } });
}

export async function cleanupTestFailedDeliveryReason(id: string): Promise<void> {
  await prisma.failed_delivery_reasons.deleteMany({ where: { id } });
}

export interface SeededSettingOverrides {
  value?: unknown;
  description?: string;
}

// Directly seeds a system_settings row, bypassing the HTTP API — there is no
// approved settings creation workflow/key catalog (Phase 5.3 intentionally
// implements no POST for settings), so tests exercising GET-by-key/PATCH
// need an isolated fixture row rather than a real approved setting (the
// table has none seeded).
export async function seedTestSetting(overrides: SeededSettingOverrides = {}): Promise<{ id: string; key: string }> {
  const key = `ph53.test.setting.${uniqueSuffix()}`;
  const setting = await prisma.system_settings.create({
    data: {
      key,
      value: (overrides.value ?? { enabled: true }) as Prisma.InputJsonValue,
      description: overrides.description,
    },
  });
  return { id: setting.id, key: setting.key };
}

export async function cleanupTestSetting(key: string): Promise<void> {
  await prisma.system_settings.deleteMany({ where: { key } });
}

// ===== Phase 6.2 — Orders =====

// Removes an order row and its dependent status-history/assignment/
// delivery-attempt rows only (order_status_history.order_id has no ON
// DELETE CASCADE; order_assignments.order_id and delivery_attempts.order_id
// are both ON DELETE RESTRICT) — never touches unrelated orders/history.
export async function cleanupTestOrder(orderId: string): Promise<void> {
  await prisma.order_status_history.deleteMany({ where: { order_id: orderId } });
  // order_assignments.order_id is ON DELETE RESTRICT (Phase 6.5) — must be
  // cleared before the order row itself, same reasoning as status history.
  await prisma.order_assignments.deleteMany({ where: { order_id: orderId } });
  // delivery_attempts.order_id is ON DELETE RESTRICT too (Phase 7.3 is the
  // first test suite to seed one directly, for the RESCHEDULED-retry
  // fixture — no production code creates these rows yet).
  await prisma.delivery_attempts.deleteMany({ where: { order_id: orderId } });
  // driver_cash_transactions.order_id is ON DELETE RESTRICT too (Phase 8.1
  // is the first suite to create real ledger rows linked to a test order).
  await prisma.driver_cash_transactions.deleteMany({ where: { order_id: orderId } });
  // wallet_transactions.order_id is ON DELETE RESTRICT too (Phase 8.2 is
  // the first suite to create real wallet ledger rows linked to an order).
  await prisma.wallet_transactions.deleteMany({ where: { order_id: orderId } });
  // company_financial_transactions.order_id is ON DELETE RESTRICT too
  // (Phase 8.3 is the first suite to create real company revenue rows
  // linked to an order).
  await prisma.company_financial_transactions.deleteMany({ where: { order_id: orderId } });
  // audit_logs has no FK to orders (entity_type/entity_id is a generic
  // polymorphic reference, not a real relation) so it never blocks this
  // delete — but it must still be cleared explicitly, or Phase 8.3's
  // DELIVERY_ONLY_FINANCE_FINALIZED rows accumulate as orphans forever.
  await prisma.audit_logs.deleteMany({ where: { entity_type: "ORDER", entity_id: orderId } });
  await prisma.orders.deleteMany({ where: { id: orderId } });
}

export interface SeededOrderOverrides {
  areaId?: string;
  areaName?: string;
  status?: OrderStatus;
  orderType?: OrderType;
  paymentType?: PaymentType;
  financialStatus?: OrderFinancialStatus;
  currentDriverId?: string;
  needsFinancialReview?: boolean;
  createdAt?: Date;
  deliveredAt?: Date;
  assignedAt?: Date;
  actualAmountCollected?: string;
  collectionDifferenceReason?: string;
  orderAmount?: string;
  deliveryFee?: string;
  prepaidOrderAmount?: string;
  prepaidDeliveryFee?: string;
  prepaidPaymentMethodId?: string;
  collectionPaymentMethodId?: string;
  receiverName?: string;
  receiverPhone?: string;
}

// Directly seeds an order row, bypassing POST /api/v1/orders — used for
// Phase 6.3 list/filter/sort fixtures that need states not yet reachable
// through any public API (e.g. a specific status, a driver already
// assigned, a past createdAt) because the transition/assignment endpoints
// belong to later phases. No order_status_history row is created (the list
// endpoint never joins it, and creating a fake transition history would
// test future workflow logic this phase must not invent).
export async function seedTestOrder(
  customerId: string,
  createdByUserId: string,
  overrides: SeededOrderOverrides = {}
): Promise<string> {
  const suffix = uniqueSuffix();
  const orderAmount = new Prisma.Decimal(overrides.orderAmount ?? "100.00");
  const deliveryFee = new Prisma.Decimal(overrides.deliveryFee ?? "5.00");
  const prepaidOrderAmount = new Prisma.Decimal(overrides.prepaidOrderAmount ?? "0");
  const prepaidDeliveryFee = new Prisma.Decimal(overrides.prepaidDeliveryFee ?? "0");
  const remainingOrderAmount = orderAmount.minus(prepaidOrderAmount);
  const remainingDeliveryFee = deliveryFee.minus(prepaidDeliveryFee);
  const amountToCollect = remainingOrderAmount.plus(remainingDeliveryFee);

  const order = await prisma.orders.create({
    data: {
      order_number: `PH63-ORD-${suffix}`,
      tracking_code: `PH63TRK${suffix}`,
      customer_id: customerId,
      created_by_id: createdByUserId,
      order_type: overrides.orderType ?? "DELIVERY_ONLY",
      status: overrides.status ?? "RECEIVED",
      financial_status: overrides.financialStatus ?? "PENDING",
      receiver_name: overrides.receiverName ?? `Phase63 Receiver ${suffix}`,
      receiver_phone: overrides.receiverPhone ?? "+96170000000",
      receiver_area_id: overrides.areaId,
      receiver_area: overrides.areaName ?? "Phase63 Area",
      receiver_address: "123 Phase63 Test St",
      description: "Phase63 seeded order",
      order_amount: orderAmount,
      delivery_fee: deliveryFee,
      payment_type: overrides.paymentType ?? "CASH_ON_DELIVERY",
      prepaid_order_amount: prepaidOrderAmount,
      prepaid_delivery_fee: prepaidDeliveryFee,
      remaining_order_amount: remainingOrderAmount,
      remaining_delivery_fee: remainingDeliveryFee,
      amount_to_collect: amountToCollect,
      prepaid_payment_method_id: overrides.prepaidPaymentMethodId,
      collection_payment_method_id: overrides.collectionPaymentMethodId,
      actual_amount_collected: overrides.actualAmountCollected,
      collection_difference_reason: overrides.collectionDifferenceReason,
      needs_financial_review: overrides.needsFinancialReview ?? false,
      current_driver_id: overrides.currentDriverId,
      assigned_at: overrides.assignedAt,
      delivered_at: overrides.deliveredAt,
      ...(overrides.createdAt ? { created_at: overrides.createdAt } : {}),
    },
  });
  return order.id;
}
