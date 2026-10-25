import "../helpers/setup";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../src/generated/prisma/client";
import { AppError } from "../../src/shared/errors/app-error";
import {
  decideFinancialReleaseMode,
  deriveExactPlannedAmounts,
  isActivationValueEnabled,
  plannedAmountProblems,
  type PlannedReleaseAmounts,
} from "../../src/modules/financial-release/financial-release.service";

// ============================================================
// FR.3 — Financial release domain rules (pure functions, no database)
// Contract: docs/settlement-financial-release-contract.md §5.1 / §5.3
// ============================================================

const d = (v: string) => new Prisma.Decimal(v);
const planned = (w: string, p: string, f: string): PlannedReleaseAmounts => ({
  customerWalletAmount: d(w),
  companyProductAmount: d(p),
  companyFeeAmount: d(f),
});

describe("Financial release domain (FR.3)", () => {
  describe("activation value", () => {
    test("only the JSON boolean true enables settlement mode (fail-safe)", () => {
      assert.equal(isActivationValueEnabled(true), true);
      for (const v of [false, null, undefined, "true", 1, { enabled: true }, [true]]) {
        assert.equal(isActivationValueEnabled(v), false, JSON.stringify(v));
      }
    });
  });

  describe("mode decision", () => {
    test("activation off -> NULL (legacy) for every route", () => {
      for (const route of ["NONE", "DIRECT_COMPANY", "DRIVER_CASH"] as const) {
        assert.equal(decideFinancialReleaseMode(false, route), null);
      }
    });
    test("activation on -> ON_SETTLEMENT only for Driver Cash; bypass and zero cash are IMMEDIATE", () => {
      assert.equal(decideFinancialReleaseMode(true, "DRIVER_CASH"), "ON_SETTLEMENT");
      assert.equal(decideFinancialReleaseMode(true, "DIRECT_COMPANY"), "IMMEDIATE");
      assert.equal(decideFinancialReleaseMode(true, "NONE"), "IMMEDIATE");
    });
  });

  describe("exact planned amounts", () => {
    test("DELIVERY_ONLY: wallet = remaining order amount, fee = remaining fee, no product revenue", () => {
      const p = deriveExactPlannedAmounts({
        orderType: "DELIVERY_ONLY",
        remainingOrderAmount: d("60.00"),
        remainingDeliveryFee: d("5.00"),
        collectionAmount: d("65.00"),
      });
      assert.equal(p.customerWalletAmount.toString(), "60");
      assert.equal(p.companyProductAmount.toString(), "0");
      assert.equal(p.companyFeeAmount.toString(), "5");
    });
    test("COMPANY_ORDER: product revenue = remaining order amount, never a wallet credit", () => {
      const p = deriveExactPlannedAmounts({
        orderType: "COMPANY_ORDER",
        remainingOrderAmount: d("40.00"),
        remainingDeliveryFee: d("5.00"),
        collectionAmount: d("45.00"),
      });
      assert.equal(p.customerWalletAmount.toString(), "0");
      assert.equal(p.companyProductAmount.toString(), "40");
      assert.equal(p.companyFeeAmount.toString(), "5");
    });
    test("zero-valued components are kept as exact zeros (prepaid fee / prepaid order)", () => {
      const feePrepaid = deriveExactPlannedAmounts({
        orderType: "DELIVERY_ONLY",
        remainingOrderAmount: d("100.00"),
        remainingDeliveryFee: d("0"),
        collectionAmount: d("100.00"),
      });
      assert.ok(feePrepaid.companyFeeAmount.isZero());
      const orderPrepaid = deriveExactPlannedAmounts({
        orderType: "DELIVERY_ONLY",
        remainingOrderAmount: d("0"),
        remainingDeliveryFee: d("5.00"),
        collectionAmount: d("5.00"),
      });
      assert.ok(orderPrepaid.customerWalletAmount.isZero());
    });
    test("a collection that does not equal remaining order + fee is rejected as corrupt data (500), never split", () => {
      assert.throws(
        () =>
          deriveExactPlannedAmounts({
            orderType: "DELIVERY_ONLY",
            remainingOrderAmount: d("100.00"),
            remainingDeliveryFee: d("5.00"),
            collectionAmount: d("95.00"),
          }),
        (e: unknown) => e instanceof AppError && e.statusCode === 500
      );
    });
  });

  describe("planned amount validation (shared with FR.5)", () => {
    test("valid splits produce no problems", () => {
      assert.deepEqual(plannedAmountProblems("DELIVERY_ONLY", d("105.00"), planned("100.00", "0", "5.00")), []);
      assert.deepEqual(plannedAmountProblems("COMPANY_ORDER", d("105.00"), planned("0", "100.00", "5.00")), []);
    });
    test("sum must equal the collected amount exactly", () => {
      assert.ok(plannedAmountProblems("DELIVERY_ONLY", d("105.00"), planned("100.00", "0", "4.99")).some((p) => /sum exactly/.test(p)));
    });
    test("COMPANY_ORDER can never credit a wallet; DELIVERY_ONLY can never produce product revenue", () => {
      assert.ok(plannedAmountProblems("COMPANY_ORDER", d("105.00"), planned("100.00", "0", "5.00")).some((p) => /COMPANY_ORDER/.test(p)));
      assert.ok(plannedAmountProblems("DELIVERY_ONLY", d("105.00"), planned("0", "100.00", "5.00")).some((p) => /DELIVERY_ONLY/.test(p)));
    });
    test("negative, over-precise and out-of-range amounts are rejected", () => {
      assert.ok(plannedAmountProblems("DELIVERY_ONLY", d("105.00"), planned("110.00", "0", "-5.00")).some((p) => /negative/.test(p)));
      assert.ok(plannedAmountProblems("DELIVERY_ONLY", d("105.001"), planned("100.001", "0", "5.00")).some((p) => /decimal places/.test(p)));
      assert.ok(plannedAmountProblems("DELIVERY_ONLY", d("1e15"), planned("1e15", "0", "0")).some((p) => /range/.test(p)));
    });
  });
});
