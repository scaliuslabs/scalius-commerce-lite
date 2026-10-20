import { hashPassword as hashWithBetterAuth } from "better-auth/crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PLAN_LIMITS, type PasswordHashSpec } from "@scalius/shared/plan-limits";
import {
  PASSWORD_HASH_PREFIX,
  hashPassword,
  isPasswordHash,
  verifyPassword,
} from "./password-hash";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const OTHER_KEY = btoa("fedcba9876543210fedcba9876543210");
const PASSWORD = "Correct-Horse-Battery-9";

const FREE = PLAN_LIMITS.free.password;
const PAID = PLAN_LIMITS.paid.password;
// A cheap scrypt for the shape tests that are not about cost.
const LIGHT_SCRYPT: PasswordHashSpec = { algorithm: "scrypt", N: 1024, r: 8, p: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("self-describing password hashes", () => {
  it("writes the Free profile's PBKDF2 format, with the cost, the key flag, a salt and the hash", async () => {
    const stored = await hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY });
    expect(stored).toMatch(/^\$sc1\$pbkdf2-sha256\$i=30000,k=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(stored.startsWith(PASSWORD_HASH_PREFIX)).toBe(true);
    expect(isPasswordHash(stored)).toBe(true);
    expect(await verifyPassword(stored, PASSWORD, { spec: FREE, pepperKey: KEY })).toEqual({ valid: true, needsRehash: false });
    expect((await verifyPassword(stored, `${PASSWORD}x`, { spec: FREE, pepperKey: KEY })).valid).toBe(false);
  });

  it("writes the Paid profile's scrypt format", async () => {
    const stored = await hashPassword(PASSWORD, { spec: PAID, pepperKey: KEY });
    expect(stored).toMatch(/^\$sc1\$scrypt\$N=16384,r=16,p=1,k=1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    expect(await verifyPassword(stored, PASSWORD, { spec: PAID, pepperKey: KEY })).toEqual({ valid: true, needsRehash: false });
    expect((await verifyPassword(stored, "wrong-Password-1", { spec: PAID, pepperKey: KEY })).valid).toBe(false);
  });

  it("uses the deployed plan's profile when no spec is given", async () => {
    expect(await hashPassword(PASSWORD, { pepperKey: KEY })).toContain("$pbkdf2-sha256$i=30000,");
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    expect(await hashPassword(PASSWORD, { pepperKey: KEY })).toContain("$scrypt$N=16384,r=16,p=1,");
  });

  it("salts every hash", async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY }), hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY })]);
    expect(a).not.toBe(b);
    expect((await verifyPassword(b, PASSWORD, { spec: FREE, pepperKey: KEY })).valid).toBe(true);
  });

  it("keys the password with a pepper derived from the credential key: another key proves nothing", async () => {
    const stored = await hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY });
    expect((await verifyPassword(stored, PASSWORD, { spec: FREE, pepperKey: OTHER_KEY })).valid).toBe(false);
    // A keyed hash cannot be checked at all without a key.
    expect(await verifyPassword(stored, PASSWORD, { spec: FREE })).toEqual({ valid: false, needsRehash: false });
    expect(await verifyPassword(stored, PASSWORD, { spec: FREE, pepperKey: "not base64 !!" })).toEqual({ valid: false, needsRehash: false });
  });

  it("makes unkeyed hashes where no key is configured, and asks to key them once one is", async () => {
    const unkeyed = await hashPassword(PASSWORD, { spec: FREE });
    expect(unkeyed).toContain("$pbkdf2-sha256$i=30000$");
    expect(await verifyPassword(unkeyed, PASSWORD, { spec: FREE })).toEqual({ valid: true, needsRehash: false });
    expect(await verifyPassword(unkeyed, PASSWORD, { spec: FREE, pepperKey: KEY })).toEqual({ valid: true, needsRehash: true });
  });

  it("treats the NFKC forms of a password as the same password", async () => {
    const stored = await hashPassword("Café-Au-Lait-2026", { spec: FREE, pepperKey: KEY });
    expect((await verifyPassword(stored, "Café-Au-Lait-2026", { spec: FREE, pepperKey: KEY })).valid).toBe(true);
  });

  it("rejects a tampered hash, a truncated one, and unknown formats without throwing", async () => {
    const stored = await hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY });
    // Tamper the hash's first character: all six of its bits are hash bits. The
    // last character of 32 bytes in base64url carries two padding bits, so
    // changing it (A <-> B, or B/C/D -> A) decodes to the very same bytes.
    const hashStart = stored.lastIndexOf("$") + 1;
    const flipped = `${stored.slice(0, hashStart)}${stored[hashStart] === "A" ? "B" : "A"}${stored.slice(hashStart + 1)}`;
    for (const bad of [flipped, stored.slice(0, -10), "", "plaintext", "$sc1$", "$sc1$md5$i=1$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAA", "$sc2$pbkdf2-sha256$i=30000$AAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAA"]) {
      expect(await verifyPassword(bad, PASSWORD, { spec: FREE, pepperKey: KEY })).toEqual({ valid: false, needsRehash: false });
    }
    expect(isPasswordHash("plaintext")).toBe(false);
  });

  it("refuses parameters that would allocate or run for too long, before deriving anything", async () => {
    const salt = "AAAAAAAAAAAAAAAAAAAAAA";
    const hash = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    for (const params of ["pbkdf2-sha256$i=999999999", "pbkdf2-sha256$i=0", "scrypt$N=1048576,r=16,p=1", "scrypt$N=1000,r=8,p=1", "scrypt$N=16384,r=8,p=1000", "scrypt$N=16384,r=8,p=1,x=y"]) {
      const started = performance.now();
      expect(await verifyPassword(`$sc1$${params}$${salt}$${hash}`, PASSWORD, { spec: FREE })).toEqual({ valid: false, needsRehash: false });
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe("a store that changes plan keeps working", () => {
  it("Free to Paid: a Free hash verifies on Paid and is upgraded to the Paid cost", async () => {
    const freeHash = await hashPassword(PASSWORD, { spec: FREE, pepperKey: KEY });
    expect(await verifyPassword(freeHash, PASSWORD, { spec: PAID, pepperKey: KEY })).toEqual({ valid: true, needsRehash: true });
  });

  it("Paid to Free: a Paid hash verifies on Free and is rewritten at the Free cost", async () => {
    const paidHash = await hashPassword(PASSWORD, { spec: PAID, pepperKey: KEY });
    expect(await verifyPassword(paidHash, PASSWORD, { spec: FREE, pepperKey: KEY })).toEqual({ valid: true, needsRehash: true });
  });

  it("a change of cost under one algorithm is upgraded too, in either direction", async () => {
    const cheaper = await hashPassword(PASSWORD, { spec: { algorithm: "pbkdf2-sha256", iterations: 10_000 }, pepperKey: KEY });
    expect((await verifyPassword(cheaper, PASSWORD, { spec: FREE, pepperKey: KEY })).needsRehash).toBe(true);
    const dearer = await hashPassword(PASSWORD, { spec: { algorithm: "pbkdf2-sha256", iterations: 60_000 }, pepperKey: KEY });
    expect((await verifyPassword(dearer, PASSWORD, { spec: FREE, pepperKey: KEY })).needsRehash).toBe(true);
    const light = await hashPassword(PASSWORD, { spec: LIGHT_SCRYPT, pepperKey: KEY });
    expect((await verifyPassword(light, PASSWORD, { spec: PAID, pepperKey: KEY })).needsRehash).toBe(true);
    expect((await verifyPassword(light, PASSWORD, { spec: LIGHT_SCRYPT, pepperKey: KEY })).needsRehash).toBe(false);
  });

  it("verifies under the deployed plan and reports against its profile", async () => {
    const freeHash = await hashPassword(PASSWORD, { pepperKey: KEY });
    expect((await verifyPassword(freeHash, PASSWORD, { pepperKey: KEY })).needsRehash).toBe(false);
    vi.stubGlobal("__SCALIUS_PLAN__", "paid");
    expect((await verifyPassword(freeHash, PASSWORD, { pepperKey: KEY })).needsRehash).toBe(true);
  });
});

describe("Better Auth's own hashes", () => {
  it("still verify, and always ask to be rewritten", async () => {
    const legacy = await hashWithBetterAuth(PASSWORD);
    expect(legacy).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(isPasswordHash(legacy)).toBe(true);
    expect(await verifyPassword(legacy, PASSWORD, { spec: FREE, pepperKey: KEY })).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPassword(legacy, PASSWORD, { spec: PAID, pepperKey: KEY })).toEqual({ valid: true, needsRehash: true });
    expect(await verifyPassword(legacy, "wrong-Password-1", { spec: FREE, pepperKey: KEY })).toEqual({ valid: false, needsRehash: false });
  });
});
