// Phase 6.1 — Order Financial Calculations + Validation: pure domain/unit
// tests. No HTTP, no database — these functions take/return Decimal values
// directly and touch nothing external, per the phase's explicit separation
// of financial calculation from database entity validation.

import "../helpers/setup";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../src/generated/prisma/client";
import { AppError } from "../../src/shared/errors/app-error";
import {
  calculateCollectionDifference,
  calculateOrderFinancials,
  deriveFinancialOwnership,
  deriveOrderFinancials,
  validatePaymentTypeConsistency,
} from "../../src/modules/orders/order-financial.service";
import {
  MONEY_MAX_VALUE,
  OrderFinancialInputSchema,
  OrderTypeSchema,
  PaymentTypeSchema,
  moneySchema,
  optionalMoneySchema,
} from "../../src/modules/orders/order-financial.schema";
import { OrderCreateFoundationSchema } from "../../src/modules/orders/order-create.schema";
import type { OrderFinancialResult } from "../../src/modules/orders/order-financial.types";

const { Decimal } = Prisma;
const d = (v: string | number) => new Decimal(v);

function assertAppError(fn: () => unknown, statusCode = 400, code = "VALIDATION_ERROR") {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AppError, "expected an AppError");
    assert.equal((error as AppError).statusCode, statusCode);
    assert.equal((error as AppError).code, code);
    return true;
  });
}

function financials(overrides: Partial<Record<"orderAmount" | "deliveryFee" | "prepaidOrderAmount" | "prepaidDeliveryFee", string | number>> = {}): OrderFinancialResult {
  return calculateOrderFinancials({
    orderAmount: d(overrides.orderAmount ?? 0),
    deliveryFee: d(overrides.deliveryFee ?? 0),
    prepaidOrderAmount: d(overrides.prepaidOrderAmount ?? 0),
    prepaidDeliveryFee: d(overrides.prepaidDeliveryFee ?? 0),
  });
}

describe("Phase 6.1 — order-financial.service: calculateOrderFinancials", () => {
  test("1. zero-value order", () => {
    const r = financials();
    assert.equal(r.remainingOrderAmount.toString(), "0");
    assert.equal(r.remainingDeliveryFee.toString(), "0");
    assert.equal(r.amountToCollect.toString(), "0");
  });

  test("2. positive order amount only", () => {
    const r = financials({ orderAmount: 100 });
    assert.equal(r.remainingOrderAmount.toString(), "100");
    assert.equal(r.amountToCollect.toString(), "100");
  });

  test("3. positive delivery fee only", () => {
    const r = financials({ deliveryFee: 5 });
    assert.equal(r.remainingDeliveryFee.toString(), "5");
    assert.equal(r.amountToCollect.toString(), "5");
  });

  test("4. both positive (requirements.md §8.1 COD example)", () => {
    const r = financials({ orderAmount: 100, deliveryFee: 5 });
    assert.equal(r.remainingOrderAmount.toString(), "100");
    assert.equal(r.remainingDeliveryFee.toString(), "5");
    assert.equal(r.amountToCollect.toString(), "105");
  });

  test("5. partial order prepayment (requirements.md §8.3 exact example: $60 remaining, $65 to collect)", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 5 });
    assert.equal(r.remainingOrderAmount.toString(), "60");
    assert.equal(r.remainingDeliveryFee.toString(), "5");
    assert.equal(r.amountToCollect.toString(), "65");
  });

  test("6. partial delivery-fee prepayment", () => {
    const r = financials({ deliveryFee: 10, prepaidDeliveryFee: 4 });
    assert.equal(r.remainingDeliveryFee.toString(), "6");
    assert.equal(r.amountToCollect.toString(), "6");
  });

  test("7. both partially prepaid", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 10, prepaidDeliveryFee: 4 });
    assert.equal(r.remainingOrderAmount.toString(), "60");
    assert.equal(r.remainingDeliveryFee.toString(), "6");
    assert.equal(r.amountToCollect.toString(), "66");
  });

  test("8. fully prepaid order amount (requirements.md §8.2 exact example: $5 to collect)", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 100, deliveryFee: 5 });
    assert.equal(r.remainingOrderAmount.toString(), "0");
    assert.equal(r.remainingDeliveryFee.toString(), "5");
    assert.equal(r.amountToCollect.toString(), "5");
  });

  test("9. fully prepaid delivery fee", () => {
    const r = financials({ deliveryFee: 5, prepaidDeliveryFee: 5 });
    assert.equal(r.remainingDeliveryFee.toString(), "0");
  });

  test("10. Decimal 0.10 / 0.20 calculate exactly (not 0.09999999999999998)", () => {
    const r = financials({ orderAmount: "0.20", prepaidOrderAmount: "0.10" });
    assert.equal(r.remainingOrderAmount.toString(), "0.1");
  });

  test("11. max supported decimal scale/precision boundary (NUMERIC(14,2))", () => {
    const r = financials({ orderAmount: MONEY_MAX_VALUE.toString(), deliveryFee: 0 });
    assert.equal(r.remainingOrderAmount.toString(), MONEY_MAX_VALUE.toString());
  });

  test("12. output never becomes floating-point-imprecise (classic 0.1 + 0.2 trap)", () => {
    assert.notEqual(0.1 + 0.2, 0.3, "sanity: JS float addition is imprecise for this input");
    const r = financials({ orderAmount: "0.1", deliveryFee: "0.2" });
    assert.equal(r.amountToCollect.toString(), "0.3");
  });
});

describe("Phase 6.1 — calculateOrderFinancials: invalid money", () => {
  test("13. negative orderAmount rejected", () => {
    assertAppError(() => financials({ orderAmount: -1 }));
  });

  test("14. negative deliveryFee rejected", () => {
    assertAppError(() => financials({ deliveryFee: -1 }));
  });

  test("15. negative prepaidOrderAmount rejected", () => {
    assertAppError(() => financials({ orderAmount: 10, prepaidOrderAmount: -1 }));
  });

  test("16. negative prepaidDeliveryFee rejected", () => {
    assertAppError(() => financials({ deliveryFee: 10, prepaidDeliveryFee: -1 }));
  });

  test("17. prepaidOrderAmount > orderAmount rejected", () => {
    assertAppError(() => financials({ orderAmount: 100, prepaidOrderAmount: 100.01 }));
  });

  test("18. prepaidDeliveryFee > deliveryFee rejected", () => {
    assertAppError(() => financials({ deliveryFee: 5, prepaidDeliveryFee: 5.01 }));
  });

  test("19. unsupported decimal scale rejected (service-level defense in depth)", () => {
    assertAppError(() =>
      calculateOrderFinancials({
        orderAmount: d("10.123"),
        deliveryFee: d(0),
        prepaidOrderAmount: d(0),
        prepaidDeliveryFee: d(0),
      })
    );
  });

  test("19b. value exceeding NUMERIC(14,2) range rejected", () => {
    assertAppError(() =>
      calculateOrderFinancials({
        orderAmount: MONEY_MAX_VALUE.plus(1),
        deliveryFee: d(0),
        prepaidOrderAmount: d(0),
        prepaidDeliveryFee: d(0),
      })
    );
  });
});

describe("Phase 6.1 — moneySchema: malformed input", () => {
  test("20. malformed numeric string rejected", () => {
    for (const bad of ["abc", "10.5.5", "", "10,50", "1e10x", "NaN"]) {
      const result = moneySchema.safeParse(bad);
      assert.equal(result.success, false, `expected "${bad}" to be rejected`);
    }
  });

  test("negative string rejected", () => {
    assert.equal(moneySchema.safeParse("-1.00").success, false);
  });

  test("more than 2 decimal places rejected", () => {
    assert.equal(moneySchema.safeParse("10.123").success, false);
  });

  test("value beyond NUMERIC(14,2) rejected", () => {
    assert.equal(moneySchema.safeParse(MONEY_MAX_VALUE.plus("0.01").toString()).success, false);
  });

  test("valid string and number both accepted and produce equal Decimals", () => {
    const fromString = moneySchema.parse("10.50");
    const fromNumber = moneySchema.parse(10.5);
    assert.equal(fromString.toString(), "10.5");
    assert.ok(fromString.equals(fromNumber));
  });

  test("optionalMoneySchema defaults to 0 when omitted", () => {
    const parsed = optionalMoneySchema.parse(undefined);
    assert.equal(parsed.toString(), "0");
  });
});

describe("Phase 6.1 — validatePaymentTypeConsistency: CASH_ON_DELIVERY", () => {
  test("21. zero prepayments valid", () => {
    assert.doesNotThrow(() => validatePaymentTypeConsistency("CASH_ON_DELIVERY", financials({ orderAmount: 100, deliveryFee: 5 })));
  });

  test("22. amountToCollect = orderAmount + deliveryFee", () => {
    const r = financials({ orderAmount: 100, deliveryFee: 5 });
    validatePaymentTypeConsistency("CASH_ON_DELIVERY", r);
    assert.equal(r.amountToCollect.toString(), "105");
  });

  test("23. contradictory prepayment rejected (order side)", () => {
    assertAppError(() =>
      validatePaymentTypeConsistency("CASH_ON_DELIVERY", financials({ orderAmount: 100, prepaidOrderAmount: 10 }))
    );
  });

  test("23b. contradictory prepayment rejected (delivery-fee side)", () => {
    assertAppError(() =>
      validatePaymentTypeConsistency("CASH_ON_DELIVERY", financials({ deliveryFee: 5, prepaidDeliveryFee: 1 }))
    );
  });
});

describe("Phase 6.1 — validatePaymentTypeConsistency: ALREADY_PAID", () => {
  test("24a. approved fully-paid combination valid (order + fee both prepaid)", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 100, deliveryFee: 5, prepaidDeliveryFee: 5 });
    assert.doesNotThrow(() => validatePaymentTypeConsistency("ALREADY_PAID", r));
  });

  test("24b. approved combination valid: order prepaid, delivery fee still due (requirements.md §8.2 example)", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 100, deliveryFee: 5 });
    assert.doesNotThrow(() => validatePaymentTypeConsistency("ALREADY_PAID", r));
  });

  test("25. amountToCollect = 0 when both fully prepaid", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 100, deliveryFee: 5, prepaidDeliveryFee: 5 });
    validatePaymentTypeConsistency("ALREADY_PAID", r);
    assert.equal(r.amountToCollect.toString(), "0");
  });

  test("26. contradictory unpaid order-amount remainder rejected", () => {
    assertAppError(() =>
      validatePaymentTypeConsistency("ALREADY_PAID", financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 5 }))
    );
  });
});

describe("Phase 6.1 — validatePaymentTypeConsistency: PARTIALLY_PAID", () => {
  test("27. partial order amount valid", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40 });
    assert.doesNotThrow(() => validatePaymentTypeConsistency("PARTIALLY_PAID", r));
  });

  test("28. partial delivery fee valid", () => {
    const r = financials({ deliveryFee: 5, prepaidDeliveryFee: 2 });
    assert.doesNotThrow(() => validatePaymentTypeConsistency("PARTIALLY_PAID", r));
  });

  test("29. both partial valid", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 5, prepaidDeliveryFee: 2 });
    assert.doesNotThrow(() => validatePaymentTypeConsistency("PARTIALLY_PAID", r));
  });

  test("30. zero prepaid total rejected as not actually partial (alias of CASH_ON_DELIVERY)", () => {
    assertAppError(() => validatePaymentTypeConsistency("PARTIALLY_PAID", financials({ orderAmount: 100, deliveryFee: 5 })));
  });

  test("31. fully prepaid everything rejected as not actually partial (alias of ALREADY_PAID)", () => {
    assertAppError(() =>
      validatePaymentTypeConsistency(
        "PARTIALLY_PAID",
        financials({ orderAmount: 100, prepaidOrderAmount: 100, deliveryFee: 5, prepaidDeliveryFee: 5 })
      )
    );
  });
});

describe("Phase 6.1 — deriveFinancialOwnership: COMPANY_ORDER", () => {
  test("32-34. remaining order amount and delivery fee both belong to the company; customer wallet due is 0", () => {
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 5 });
    const ownership = deriveFinancialOwnership("COMPANY_ORDER", r.remainingOrderAmount, r.remainingDeliveryFee, r.amountToCollect);

    assert.equal(ownership.companyOrderAmountDue.toString(), "60");
    assert.equal(ownership.companyDeliveryFeeDue.toString(), "5");
    assert.equal(ownership.customerWalletAmountDue.toString(), "0");
    assert.equal(ownership.customerOwnedOrderAmountDue.toString(), "0");
    assert.equal(ownership.expectedDriverCollection.toString(), r.amountToCollect.toString());
  });
});

describe("Phase 6.1 — deriveFinancialOwnership: DELIVERY_ONLY", () => {
  test("35-37. remaining order amount is customer-owned, delivery fee is company-owned, expected collection = sum (requirements.md §10.2 example)", () => {
    // requirements.md §10.2: value $100, already paid $40, delivery fee $5 -> driver collects $65
    const r = financials({ orderAmount: 100, prepaidOrderAmount: 40, deliveryFee: 5 });
    const ownership = deriveFinancialOwnership("DELIVERY_ONLY", r.remainingOrderAmount, r.remainingDeliveryFee, r.amountToCollect);

    assert.equal(ownership.customerOwnedOrderAmountDue.toString(), "60");
    assert.equal(ownership.companyDeliveryFeeDue.toString(), "5");
    assert.equal(ownership.companyOrderAmountDue.toString(), "0");
    assert.equal(ownership.customerWalletAmountDue.toString(), "60", "expected wallet credit mirrors the customer-owned remaining order amount");
    assert.equal(ownership.expectedDriverCollection.toString(), "65");
    assert.equal(ownership.expectedDriverCollection.toString(), r.remainingOrderAmount.plus(r.remainingDeliveryFee).toString());
  });
});

describe("Phase 6.1 — deriveOrderFinancials (composed convenience function)", () => {
  test("composes calculation + payment-type validation + ownership derivation", () => {
    const result = deriveOrderFinancials("DELIVERY_ONLY", "PARTIALLY_PAID", {
      orderAmount: d(100),
      deliveryFee: d(5),
      prepaidOrderAmount: d(40),
      prepaidDeliveryFee: d(0),
    });
    assert.equal(result.amountToCollect.toString(), "65");
    assert.equal(result.ownership.customerOwnedOrderAmountDue.toString(), "60");
  });

  test("propagates payment-type inconsistency as an AppError", () => {
    assertAppError(() =>
      deriveOrderFinancials("COMPANY_ORDER", "CASH_ON_DELIVERY", {
        orderAmount: d(100),
        deliveryFee: d(5),
        prepaidOrderAmount: d(10),
        prepaidDeliveryFee: d(0),
      })
    );
  });
});

describe("Phase 6.1 — calculateCollectionDifference", () => {
  test("38. exact collection -> difference 0, no review", () => {
    const result = calculateCollectionDifference(d(105), d(105));
    assert.equal(result.collectionDifference.toString(), "0");
    assert.equal(result.needsFinancialReview, false);
  });

  test("39. short collection -> negative difference, review required", () => {
    const result = calculateCollectionDifference(d(105), d(95));
    assert.equal(result.collectionDifference.toString(), "-10");
    assert.equal(result.needsFinancialReview, true);
  });

  test("40. overcollection -> positive difference, review required", () => {
    const result = calculateCollectionDifference(d(105), d(110));
    assert.equal(result.collectionDifference.toString(), "5");
    assert.equal(result.needsFinancialReview, true);
  });

  test("41. Decimal precision maintained on a non-round difference", () => {
    const result = calculateCollectionDifference(d("105.00"), d("94.95"));
    assert.equal(result.collectionDifference.toString(), "-10.05");
    assert.equal(result.needsFinancialReview, true);
  });

  test("never guesses a customer/company allocation for a Delivery Only shortfall", () => {
    const result = calculateCollectionDifference(d(105), d(95));
    assert.deepEqual(Object.keys(result).sort(), [
      "actualAmountCollected",
      "collectionDifference",
      "expectedAmountToCollect",
      "needsFinancialReview",
    ]);
    // No allocation-shaped field exists anywhere in the result to guess with.
    for (const key of Object.keys(result)) {
      assert.doesNotMatch(key, /customer|company|wallet|split|allocation/i);
    }
  });

  test("rejects an invalid actualAmountCollected the same way as any other money field", () => {
    assertAppError(() => calculateCollectionDifference(d(105), d(-5)));
  });
});

describe("Phase 6.1 — schema foundation: enums", () => {
  test("42. valid enum values accepted", () => {
    assert.equal(OrderTypeSchema.safeParse("COMPANY_ORDER").success, true);
    assert.equal(OrderTypeSchema.safeParse("DELIVERY_ONLY").success, true);
    assert.equal(PaymentTypeSchema.safeParse("CASH_ON_DELIVERY").success, true);
    assert.equal(PaymentTypeSchema.safeParse("ALREADY_PAID").success, true);
    assert.equal(PaymentTypeSchema.safeParse("PARTIALLY_PAID").success, true);
  });

  test("43. invalid order type rejected", () => {
    assert.equal(OrderTypeSchema.safeParse("DELIVERY_AND_COMPANY").success, false);
    assert.equal(OrderTypeSchema.safeParse("").success, false);
  });

  test("44. invalid payment type rejected", () => {
    assert.equal(PaymentTypeSchema.safeParse("CREDIT").success, false);
    assert.equal(PaymentTypeSchema.safeParse("PAID").success, false);
  });
});

describe("Phase 6.1 — OrderFinancialInputSchema", () => {
  test("valid financial input parses into Decimal fields", () => {
    const parsed = OrderFinancialInputSchema.parse({
      orderAmount: "100.00",
      deliveryFee: "5.00",
      prepaidOrderAmount: "40.00",
    });
    assert.ok(parsed.orderAmount instanceof Decimal);
    assert.equal(parsed.prepaidDeliveryFee.toString(), "0", "prepaidDeliveryFee defaults to 0 when omitted");
  });
});

describe("Phase 6.1 — OrderCreateFoundationSchema", () => {
  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      customerId: randomUUID(),
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "Jane Doe",
      receiverPhone: "+96170000000",
      receiverAreaId: randomUUID(),
      receiverAddress: "123 Main St",
      description: "1 box of electronics",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      // amountToCollect = 105 > 0 by default (no prepaid amounts below), so
      // a valid base body must include a collection method per the new
      // superRefine rule.
      collectionPaymentMethodId: randomUUID(),
      ...overrides,
    };
  }

  test("45. valid UUID fields accepted", () => {
    const result = OrderCreateFoundationSchema.safeParse(
      validBody({
        receiverAreaId: randomUUID(),
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: randomUUID(),
        collectionPaymentMethodId: randomUUID(),
      })
    );
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  test("46. malformed UUIDs rejected", () => {
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ customerId: "not-a-uuid" })).success, false);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverAreaId: "not-a-uuid" })).success, false);
    assert.equal(
      OrderCreateFoundationSchema.safeParse(
        validBody({ prepaidOrderAmount: "10.00", prepaidPaymentMethodId: "not-a-uuid" })
      ).success,
      false
    );
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ collectionPaymentMethodId: "not-a-uuid" })).success, false);
  });

  test("47. receiver required fields enforced", () => {
    for (const field of ["receiverName", "receiverPhone", "receiverAreaId", "receiverAddress", "description", "customerId", "orderType", "paymentType", "orderAmount", "deliveryFee"]) {
      const body = validBody();
      delete (body as Record<string, unknown>)[field];
      const result = OrderCreateFoundationSchema.safeParse(body);
      assert.equal(result.success, false, `expected missing "${field}" to be rejected`);
    }
  });

  test("required receiverAreaId: the V1 design no longer accepts independent free-text receiverArea input", () => {
    const withoutAreaId = validBody();
    delete (withoutAreaId as Record<string, unknown>).receiverAreaId;
    assert.equal(OrderCreateFoundationSchema.safeParse(withoutAreaId).success, false);

    // Sending the old client-text field is silently stripped (unknown key),
    // never persisted or trusted — the receiver_area snapshot must instead
    // be derived server-side from the loaded Area (Phase 6.2).
    const parsed = OrderCreateFoundationSchema.parse(validBody({ receiverArea: "Some Client-Typed Area Text" }));
    assert.ok(!("receiverArea" in parsed), "receiverArea must not survive parsing — it is not a schema field");
  });

  test("48. text length limits match real DB varchar constraints", () => {
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverName: "x".repeat(200) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverName: "x".repeat(201) })).success, false);

    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverPhone: "x".repeat(30) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverPhone: "x".repeat(31) })).success, false);

    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverAltPhone: "x".repeat(30) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverAltPhone: "x".repeat(31) })).success, false);

    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverAddress: "x".repeat(500) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverAddress: "x".repeat(501) })).success, false);

    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverBuildingFloor: "x".repeat(200) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverBuildingFloor: "x".repeat(201) })).success, false);

    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverMapLink: "x".repeat(1000) })).success, true);
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ receiverMapLink: "x".repeat(1001) })).success, false);

    // description/receiverInstructions/packageNotes are unbounded `text`
    // columns in the approved schema — no invented max length.
    assert.equal(OrderCreateFoundationSchema.safeParse(validBody({ description: "x".repeat(5000) })).success, true);
  });

  test("49. client cannot supply server-controlled financial results — they are stripped, not applied", () => {
    const parsed = OrderCreateFoundationSchema.parse(
      validBody({
        remainingOrderAmount: "999999.99",
        remainingDeliveryFee: "999999.99",
        amountToCollect: "999999.99",
      })
    );
    assert.ok(!("remainingOrderAmount" in parsed));
    assert.ok(!("remainingDeliveryFee" in parsed));
    assert.ok(!("amountToCollect" in parsed));
  });

  test("50. client cannot supply actualAmountCollected or any other server-derived/lifecycle field at create time", () => {
    const parsed = OrderCreateFoundationSchema.parse(
      validBody({
        actualAmountCollected: "999999.99",
        id: randomUUID(),
        orderNumber: "SHOULD-NOT-APPLY",
        trackingCode: "SHOULD-NOT-APPLY",
        status: "DELIVERED",
        financialStatus: "FINALIZED",
        needsFinancialReview: true,
        currentDriverId: randomUUID(),
        createdById: randomUUID(),
        createdAt: "2000-01-01T00:00:00.000Z",
      })
    );
    for (const key of [
      "actualAmountCollected",
      "id",
      "orderNumber",
      "trackingCode",
      "status",
      "financialStatus",
      "needsFinancialReview",
      "currentDriverId",
      "createdById",
      "createdAt",
    ]) {
      assert.ok(!(key in parsed), `"${key}" must not survive parsing`);
    }
  });
});

describe("Phase 6.1 cleanup — OrderCreateFoundationSchema: payment-method cross-field rules", () => {
  function validBody(overrides: Record<string, unknown> = {}) {
    return {
      customerId: randomUUID(),
      orderType: "DELIVERY_ONLY",
      paymentType: "CASH_ON_DELIVERY",
      receiverName: "Jane Doe",
      receiverPhone: "+96170000000",
      receiverAreaId: randomUUID(),
      receiverAddress: "123 Main St",
      description: "1 box of electronics",
      orderAmount: "100.00",
      deliveryFee: "5.00",
      collectionPaymentMethodId: randomUUID(),
      ...overrides,
    };
  }

  function issuePaths(result: ReturnType<typeof OrderCreateFoundationSchema.safeParse>): string[] {
    return result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));
  }

  test("prepaid amount > 0 without prepaidPaymentMethodId -> rejected", () => {
    const result = OrderCreateFoundationSchema.safeParse(validBody({ prepaidOrderAmount: "40.00" }));
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("prepaidPaymentMethodId"));
  });

  test("prepaid amount > 0 with prepaidPaymentMethodId -> accepted", () => {
    const result = OrderCreateFoundationSchema.safeParse(
      validBody({ prepaidOrderAmount: "40.00", prepaidPaymentMethodId: randomUUID() })
    );
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  test("prepaid amount > 0 (delivery-fee side only) without prepaidPaymentMethodId -> rejected", () => {
    const result = OrderCreateFoundationSchema.safeParse(validBody({ prepaidDeliveryFee: "2.00" }));
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("prepaidPaymentMethodId"));
  });

  test("zero prepaid with prepaidPaymentMethodId provided -> rejected", () => {
    const result = OrderCreateFoundationSchema.safeParse(validBody({ prepaidPaymentMethodId: randomUUID() }));
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("prepaidPaymentMethodId"));
  });

  test("zero prepaid with prepaidPaymentMethodId explicitly null -> accepted (null counts as absent)", () => {
    const result = OrderCreateFoundationSchema.safeParse(validBody({ prepaidPaymentMethodId: null }));
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  test("amountToCollect > 0 without collectionPaymentMethodId -> rejected", () => {
    const body = validBody();
    delete (body as Record<string, unknown>).collectionPaymentMethodId;
    const result = OrderCreateFoundationSchema.safeParse(body);
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("collectionPaymentMethodId"));
  });

  test("amountToCollect > 0 with collectionPaymentMethodId -> accepted", () => {
    const result = OrderCreateFoundationSchema.safeParse(validBody({ collectionPaymentMethodId: randomUUID() }));
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  test("amountToCollect = 0 (fully prepaid) with collectionPaymentMethodId provided -> rejected", () => {
    const result = OrderCreateFoundationSchema.safeParse(
      validBody({
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: randomUUID(),
        collectionPaymentMethodId: randomUUID(),
      })
    );
    assert.equal(result.success, false);
    assert.ok(issuePaths(result).includes("collectionPaymentMethodId"));
  });

  test("amountToCollect = 0 (fully prepaid) with collectionPaymentMethodId absent/null -> accepted", () => {
    const result = OrderCreateFoundationSchema.safeParse(
      validBody({
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: randomUUID(),
        collectionPaymentMethodId: null,
      })
    );
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });

  test("amountToCollect is computed server-side from orderAmount/deliveryFee/prepaid — never trusts a client-supplied amountToCollect", () => {
    // amountToCollect is not even a field on this schema, so a client
    // cannot influence the collectionPaymentMethodId requirement by sending
    // one — the real amounts (which yield amountToCollect = 105) still
    // drive the rule regardless of what extra "amountToCollect" is injected.
    const body = validBody({ amountToCollect: "0" });
    delete (body as Record<string, unknown>).collectionPaymentMethodId;
    const result = OrderCreateFoundationSchema.safeParse(body);
    assert.equal(result.success, false, "an injected amountToCollect=0 must not bypass the real 105 computed from orderAmount/deliveryFee");
  });

  test("both rules apply together: partially prepaid order still requires both a prepaid and a collection method", () => {
    const result = OrderCreateFoundationSchema.safeParse(
      validBody({ prepaidOrderAmount: "40.00", prepaidPaymentMethodId: randomUUID(), collectionPaymentMethodId: randomUUID() })
    );
    assert.equal(result.success, true, JSON.stringify(!result.success && result.error.issues));
  });
});
