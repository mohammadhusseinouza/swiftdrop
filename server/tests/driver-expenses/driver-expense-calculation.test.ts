import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "../../src/generated/prisma/client";
import {
  calculateCostPerKm,
  calculateEstimatedExpense,
  calculatePricePerLiter,
  formatExactDecimal,
  resolveConsumptionRate,
} from "../../src/modules/driver-expenses/driver-expense-calculation";

// Pure engine — no DB. Every expectation is an exact decimal string.
const s = (d: Prisma.Decimal) => formatExactDecimal(d);

describe("Driver Expenses calculation engine", () => {
  test("price per liter = price per 20 L / 20", () => {
    assert.equal(s(calculatePricePerLiter("25.50")), "1.275");
    assert.equal(s(calculatePricePerLiter("20.00")), "1");
    assert.equal(s(calculatePricePerLiter("0.01")), "0.0005");
  });

  test("cost per km = price per liter * consumption / 100", () => {
    assert.equal(s(calculateCostPerKm("25.50", "3.40")), "0.04335");
    assert.equal(s(calculateCostPerKm("25.50", "8.75")), "0.1115625");
  });

  test("estimated expense = distance * cost per km, exact", () => {
    assert.equal(s(calculateEstimatedExpense("37.25", "25.50", "3.40")), "1.6147875");
    assert.equal(s(calculateEstimatedExpense("120.40", "25.50", "8.75")), "13.432125");
    assert.equal(s(calculateEstimatedExpense("0", "25.50", "8.75")), "0");
  });

  test("estimated expense equals distance * calculateCostPerKm (composable)", () => {
    const viaCostPerKm = new Prisma.Decimal("37.25").times(calculateCostPerKm("25.50", "3.40"));
    assert.equal(s(calculateEstimatedExpense("37.25", "25.50", "3.40")), s(viaCostPerKm));
  });

  test("never rounds, even beyond Prisma Decimal's default 20-digit precision", () => {
    // Column maxima: price NUMERIC(14,2), consumption NUMERIC(6,2), distance NUMERIC(8,2).
    assert.equal(
      s(calculateEstimatedExpense("999999.99", "999999999999.99", "9999.99")),
      "4999994950000000000.0504999995"
    );
    // Prisma's default context would have rounded this.
    const naive = new Prisma.Decimal("999999.99").times("999999999999.99").times("9999.99").times("0.0005");
    assert.notEqual(s(naive), "4999994950000000000.0504999995");
  });

  test("tiny values are plain decimal text, never exponent notation", () => {
    const tiny = calculateCostPerKm("0.01", "0.01");
    assert.equal(s(tiny), "0.00000005");
    assert.ok(!s(tiny).includes("e"));
  });

  test("accepts Prisma.Decimal inputs and returns Prisma.Decimal", () => {
    const out = calculateEstimatedExpense(
      new Prisma.Decimal("10"),
      new Prisma.Decimal("25.50"),
      new Prisma.Decimal("8.75")
    );
    assert.ok(Prisma.Decimal.isDecimal(out));
    assert.equal(s(out), "1.115625");
  });

  test("resolveConsumptionRate picks the vehicle type's rate", () => {
    const rates = { motorcycleConsumptionLPer100Km: "3.40", carConsumptionLPer100Km: new Prisma.Decimal("8.75") };
    assert.equal(s(resolveConsumptionRate(rates, "MOTORCYCLE")), "3.4");
    assert.equal(s(resolveConsumptionRate(rates, "CAR")), "8.75");
    assert.throws(() => resolveConsumptionRate(rates, "TRUCK" as never));
  });
});
