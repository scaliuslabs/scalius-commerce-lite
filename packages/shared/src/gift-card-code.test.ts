import { describe, expect, it } from "vitest";

import {
  CROCKFORD_BASE32_ALPHABET,
  formatGiftCardCode,
  generateGiftCardCode,
  GIFT_CARD_APPLY_HANDLE_PURPOSE,
  GIFT_CARD_CODE_CIPHER_PURPOSE,
  GIFT_CARD_CODE_HASH_PURPOSE,
  GIFT_CARD_CODE_LENGTH,
  GIFT_CARD_CODE_RANDOM_BYTES,
  giftCardCodeLast4,
  isGiftCardCode,
  maskGiftCardCode,
  normalizeGiftCardCode,
} from "./gift-card-code";

const cryptoBytes = (length: number) => crypto.getRandomValues(new Uint8Array(length));

describe("gift-card code shape", () => {
  it("is 16 Crockford symbols carrying 80 bits", () => {
    expect(CROCKFORD_BASE32_ALPHABET).toHaveLength(32);
    expect(new Set(CROCKFORD_BASE32_ALPHABET).size).toBe(32);
    expect(CROCKFORD_BASE32_ALPHABET).not.toMatch(/[ILOU]/);
    expect(GIFT_CARD_CODE_LENGTH).toBe(16);
    expect(GIFT_CARD_CODE_RANDOM_BYTES).toBe(10);
  });

  it("names the key-derivation purposes", () => {
    expect(GIFT_CARD_CODE_HASH_PURPOSE).toBe("gift-card-code-hash-v1");
    expect(GIFT_CARD_CODE_CIPHER_PURPOSE).toBe("gift-card-code-v1");
    expect(GIFT_CARD_APPLY_HANDLE_PURPOSE).toBe("gift-card-apply-handle");
  });
});

describe("generateGiftCardCode", () => {
  it("maps the 80 bits onto symbols exactly (big-endian 5-bit groups)", () => {
    expect(generateGiftCardCode(() => new Uint8Array(10))).toBe("0000000000000000");
    expect(generateGiftCardCode(() => new Uint8Array(10).fill(0xff))).toBe("ZZZZZZZZZZZZZZZZ");
    // 0x08 0x86 0x42 0x98 0xe8 = 00001 00010 00011 00100 00101 00110 00111 01000
    const bytes = new Uint8Array([0x08, 0x86, 0x42, 0x98, 0xe8, 0x08, 0x86, 0x42, 0x98, 0xe8]);
    expect(generateGiftCardCode(() => bytes)).toBe("1234567812345678");
  });

  it("asks for exactly 10 bytes and refuses a short source", () => {
    const requested: number[] = [];
    generateGiftCardCode((length) => {
      requested.push(length);
      return new Uint8Array(length);
    });
    expect(requested).toEqual([10]);
    expect(() => generateGiftCardCode(() => new Uint8Array(9))).toThrow(RangeError);
    expect(() => generateGiftCardCode(() => new Uint8Array(11))).toThrow(RangeError);
  });

  it("produces canonical, distinct codes with every symbol roughly uniform", () => {
    const counts = new Map<string, number>();
    const codes = new Set<string>();
    const rounds = 4_000;
    for (let round = 0; round < rounds; round += 1) {
      const code = generateGiftCardCode(cryptoBytes);
      expect(isGiftCardCode(code)).toBe(true);
      expect(normalizeGiftCardCode(code)).toBe(code);
      codes.add(code);
      for (const symbol of code) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
    }
    expect(codes.size).toBe(rounds);
    expect(counts.size).toBe(32);
    const expected = (rounds * 16) / 32; // 2,000 per symbol
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(expected * 0.85);
      expect(count).toBeLessThan(expected * 1.15);
    }
  });
});

describe("normalizeGiftCardCode", () => {
  it("accepts the shown format, lowercase, spaces and any dash", () => {
    expect(normalizeGiftCardCode("ABCD-EFGH-JKMN-PQRS")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeGiftCardCode(" abcd efgh jkmn pqrs ")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeGiftCardCode("abcd–efgh—jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
  });

  it("reads O as 0 and I/L as 1 (Crockford decoding)", () => {
    expect(normalizeGiftCardCode("OOOO-IIII-LLLL-oil0")).toBe("0000111111110110");
  });

  it("reads Bangla digits and full-width characters", () => {
    expect(normalizeGiftCardCode("০১২৩-৪৫৬৭-৮৯AB-CDEF")).toBe("0123456789ABCDEF");
    expect(normalizeGiftCardCode("ＡＢＣＤ-EFGH-JKMN-PQRS")).toBe("ABCDEFGHJKMNPQRS");
  });

  it("refuses U, other symbols and wrong lengths", () => {
    expect(normalizeGiftCardCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
    expect(normalizeGiftCardCode("ABCD-EFGH-JKMN-PQR!")).toBeNull();
    expect(normalizeGiftCardCode("ABCD_EFGH_JKMN_PQRS")).toBeNull();
    expect(normalizeGiftCardCode("ABCD-EFGH-JKMN-PQR")).toBeNull();
    expect(normalizeGiftCardCode("ABCD-EFGH-JKMN-PQRST")).toBeNull();
    expect(normalizeGiftCardCode("")).toBeNull();
    expect(normalizeGiftCardCode(null)).toBeNull();
    expect(normalizeGiftCardCode(`${" ".repeat(60)}ABCDEFGHJKMNPQRS`)).toBeNull();
  });
});

describe("display helpers", () => {
  const code = "7K2QABCDEFGH7K2Q";

  it("formats in groups of four", () => {
    expect(formatGiftCardCode(code)).toBe("7K2Q-ABCD-EFGH-7K2Q");
    expect(formatGiftCardCode("7k2q abcd efgh 7k2q")).toBe("7K2Q-ABCD-EFGH-7K2Q");
    expect(() => formatGiftCardCode("nope")).toThrow(RangeError);
  });

  it("exposes only the last four symbols", () => {
    expect(giftCardCodeLast4(code)).toBe("7K2Q");
    expect(maskGiftCardCode(code)).toBe("•••• 7K2Q");
    expect(maskGiftCardCode("7K2Q")).toBe("•••• 7K2Q");
    expect(() => maskGiftCardCode("7K2")).toThrow(RangeError);
  });
});
