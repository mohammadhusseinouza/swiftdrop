import { describe, test } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import {
  PHONE_ALLOWED_PATTERN,
  PHONE_CHARACTERS_MESSAGE,
  PHONE_DIGIT_REQUIRED_MESSAGE,
  phoneFormatIssue,
  receiverPhoneSchema,
  toAsciiDigits,
} from "../../src/shared/phone/phone-format";
import { normalizeReceiverPhone } from "../../src/shared/phone/receiver-phone";

const schema = receiverPhoneSchema("Receiver phone is required");

function parse(value: string) {
  return schema.safeParse(value);
}

function firstMessage(value: string): string | undefined {
  const result = parse(value);
  return result.success ? undefined : result.error.issues[0]?.message;
}

describe("receiver phone format", () => {
  describe("valid Lebanese and international numbers", () => {
    for (const value of [
      "03123456",
      "03 123 456",
      "03-123-456",
      "03.123.456",
      "(03) 123456",
      "70 123 456",
      "+961 3 123 456",
      "+961 (70) 123-456",
      "+961.70.123.456",
      "009613123456",
      "+1 (555) 123-4567",
      "+44 20 7946 0958",
      "+33 6 12 34 56 78",
      "123", // no fixed digit count
      "1".repeat(30),
    ]) {
      test(`accepts "${value}"`, () => {
        const result = parse(value);
        assert.equal(result.success, true, JSON.stringify(result.error?.issues));
        assert.equal(result.data, value, "a valid value is never rewritten");
      });
    }
  });

  describe("Arabic-Indic digits are converted to ASCII", () => {
    test("Arabic-Indic digits", () => {
      assert.equal(toAsciiDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
      assert.deepEqual(parse("٠٣ ١٢٣ ٤٥٦"), { success: true, data: "03 123 456" });
    });

    test("Eastern Arabic-Indic digits", () => {
      assert.equal(toAsciiDigits("۰۱۲۳۴۵۶۷۸۹"), "0123456789");
      assert.deepEqual(parse("+۹۶۱ ۷۰ ۱۲۳ ۴۵۶"), { success: true, data: "+961 70 123 456" });
    });

    test("surrounding whitespace is trimmed", () => {
      assert.deepEqual(parse("  03 123 456  "), { success: true, data: "03 123 456" });
    });
  });

  describe("rejections", () => {
    const characters = [
      ["Latin letters", "03 123 456 ext"],
      ["a single Latin letter", "03123456x"],
      ["Arabic letters", "٠٣ ١٢٣ ٤٥٦ تحويلة"],
      ["Cyrillic letters", "03 123 456 доб"],
      ["slash", "03/123456"],
      ["hash", "03123456#1"],
      ["comma", "03,123,456"],
      ["underscore", "03_123_456"],
      ["asterisk", "*03123456"],
      ["tab inside", "03\t123456"],
      ["plus in the middle", "03+123456"],
      ["trailing plus", "03123456+"],
      ["double leading plus", "++9613123456"],
      ["two plus signs", "+961 +3 123456"],
    ] as const;
    for (const [label, value] of characters) {
      test(`${label}: "${value}"`, () => {
        assert.equal(firstMessage(value), PHONE_CHARACTERS_MESSAGE);
      });
    }

    test("no digits", () => {
      for (const value of ["+", "()", "- - -", "+ ( ) . -"]) {
        assert.equal(firstMessage(value), PHONE_DIGIT_REQUIRED_MESSAGE, value);
      }
    });

    test("empty -> required", () => {
      assert.equal(firstMessage(""), "Receiver phone is required");
      assert.equal(firstMessage("   "), "Receiver phone is required");
    });

    test("more than 30 characters", () => {
      assert.equal(parse("1".repeat(31)).success, false);
      assert.equal(parse("+961 70 123 456 789 012 345 67").success, true); // exactly 30
      assert.equal(parse("+961 70 123 456 789 012 345 678").success, false); // 31
    });
  });

  describe("compatibility with receiver normalization", () => {
    test("every accepted value normalizes exactly as the raw input does", () => {
      for (const value of ["03.123.456", "(03) 123-456", "+961 (70) 123-456", "٠٣ ١٢٣ ٤٥٦", "+1 (555) 123-4567"]) {
        const parsed = parse(value);
        assert.equal(parsed.success, true, value);
        assert.equal(normalizeReceiverPhone(parsed.data), normalizeReceiverPhone(value), value);
      }
      assert.equal(normalizeReceiverPhone("03.123.456"), "+9613123456");
      assert.equal(normalizeReceiverPhone("٠٣ ١٢٣ ٤٥٦"), "+9613123456");
    });

    test("format-valid but unrecognized numbers stay valid input (memory is skipped, order is not blocked)", () => {
      assert.equal(phoneFormatIssue("123"), null);
      assert.equal(normalizeReceiverPhone("123"), null);
    });
  });
});

describe("frontend parity (client/src/lib/phoneFormat.ts)", () => {
  // The client has no test runner and cannot be imported here (separate
  // package / rootDir), so the shared policy is compared as source text.
  const clientSource = readFileSync(path.resolve(__dirname, "../../../client/src/lib/phoneFormat.ts"), "utf8");

  test("same allowed-character pattern", () => {
    assert.ok(clientSource.includes(`PHONE_ALLOWED_PATTERN = ${PHONE_ALLOWED_PATTERN.toString()};`));
    assert.ok(clientSource.includes(String.raw`PHONE_CHARACTERS_ONLY = /^\+?[0-9 ().-]*$/;`));
  });

  test("same 30-character limit and digit conversion ranges", () => {
    assert.ok(clientSource.includes("PHONE_MAX_LENGTH = 30;"));
    assert.ok(clientSource.includes(String.raw`/[\u0660-\u0669]/g`));
    assert.ok(clientSource.includes(String.raw`/[\u06F0-\u06F9]/g`));
  });
});
