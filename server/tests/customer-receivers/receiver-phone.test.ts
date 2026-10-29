import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { normalizeReceiverPhone, receiverPhoneSearchDigits } from "../../src/shared/phone/receiver-phone";

describe("normalizeReceiverPhone (Customer Receiver Memory)", () => {
  describe("Lebanese local and international forms are equivalent", () => {
    const legacyMobile = "+9613123456";
    for (const raw of [
      "03123456",
      "03 123 456",
      "03-123-456",
      "03.123.456",
      "(03) 123456",
      "  03 123456  ",
      "+961 3 123 456",
      "+961-3-123456",
      "+961 03 123456",
      "00961 3 123456",
      "009613123456",
      "961 3 123456",
      "9613123456",
      "٠٣١٢٣٤٥٦",
    ]) {
      test(`"${raw}" -> ${legacyMobile}`, () => {
        assert.equal(normalizeReceiverPhone(raw), legacyMobile);
      });
    }

    const mobile = "+96170123456";
    for (const raw of ["70123456", "70 123 456", "070 123 456", "+961 70 123 456", "+961 070 123456", "0096170123456", "96170123456"]) {
      test(`"${raw}" -> ${mobile}`, () => {
        assert.equal(normalizeReceiverPhone(raw), mobile);
      });
    }

    test("Beirut landline with trunk zero", () => {
      assert.equal(normalizeReceiverPhone("01 234 567"), "+9611234567");
      assert.equal(normalizeReceiverPhone("+961 1 234567"), "+9611234567");
    });

    test("81 mobile range", () => {
      assert.equal(normalizeReceiverPhone("81 123 456"), "+96181123456");
    });
  });

  describe("unrelated numbers never collide", () => {
    test("different Lebanese numbers stay different", () => {
      assert.notEqual(normalizeReceiverPhone("03 123456"), normalizeReceiverPhone("03 123457"));
      assert.notEqual(normalizeReceiverPhone("70 123456"), normalizeReceiverPhone("71 123456"));
    });

    test("7-digit landline 07 and 8-digit mobile 7x are distinct", () => {
      assert.equal(normalizeReceiverPhone("07 123456"), "+9617123456");
      assert.equal(normalizeReceiverPhone("71 234567"), "+96171234567");
      assert.notEqual(normalizeReceiverPhone("07 123456"), normalizeReceiverPhone("71 23456"));
    });

    test("same national digits under another country code are not Lebanese", () => {
      assert.equal(normalizeReceiverPhone("+962 70 123456"), "+96270123456");
      assert.notEqual(normalizeReceiverPhone("+962 70 123456"), normalizeReceiverPhone("70 123456"));
    });
  });

  describe("international numbers keep their country", () => {
    test("+ and 00 prefixes are equivalent", () => {
      assert.equal(normalizeReceiverPhone("+1 (555) 123-4567"), "+15551234567");
      assert.equal(normalizeReceiverPhone("001 555 123 4567"), "+15551234567");
      assert.equal(normalizeReceiverPhone("+44 20 7946 0958"), "+442079460958");
      assert.equal(normalizeReceiverPhone("+33 6 12 34 56 78"), "+33612345678");
    });

    test("length bounds", () => {
      assert.equal(normalizeReceiverPhone("+1234567"), null); // 7 digits — too short
      assert.equal(normalizeReceiverPhone("+1234567890123456"), null); // 16 digits — too long
      assert.equal(normalizeReceiverPhone("+123456789012345"), "+123456789012345");
    });

    test("a country code cannot start with 0", () => {
      assert.equal(normalizeReceiverPhone("+0 123 456 789"), null);
    });
  });

  describe("malformed and ambiguous input is rejected (no guessed match)", () => {
    for (const raw of [
      "",
      "   ",
      "+",
      "00",
      "++9613123456",
      "03 123456 ext 2",
      "03123456#1",
      "abc",
      "03 12345", // too short for a Lebanese number
      "03 1234567", // too long
      "02 123456", // no 02 range
      "123456", // no country, not Lebanese
      "5551234567", // a foreign number written without its country code
      "+961 2 123456",
      "+961 123",
      "961 12",
    ]) {
      test(`"${raw}" -> null`, () => {
        assert.equal(normalizeReceiverPhone(raw), null);
      });
    }

    test("null / undefined", () => {
      assert.equal(normalizeReceiverPhone(null), null);
      assert.equal(normalizeReceiverPhone(undefined), null);
    });
  });
});

describe("receiverPhoneSearchDigits", () => {
  test("strips formatting and leading zeros", () => {
    assert.equal(receiverPhoneSearchDigits("03 12"), "312");
    assert.equal(receiverPhoneSearchDigits("+961 3"), "9613");
  });

  test("too few digits is not a phone search", () => {
    assert.equal(receiverPhoneSearchDigits("Ahmad"), null);
    assert.equal(receiverPhoneSearchDigits("03"), null);
    assert.equal(receiverPhoneSearchDigits("0 0 1"), null);
  });
});
