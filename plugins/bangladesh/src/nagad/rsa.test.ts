// The RSA module against an independent implementation (a ciphertext made by
// OpenSSL) and against the RFC 8017 block format, checked with a plain
// non-CRT exponentiation written here, plus key import and signatures.

import { beforeAll, describe, expect, it } from "vitest";
import { generateKeyPair, type KeyPair } from "./mock-nagad";
import {
  base64ToBytes,
  bytesToBase64,
  decryptPkcs1v15,
  encryptPkcs1v15,
  importRsaPrivateKey,
  importRsaPublicKey,
  RsaError,
  signSha256,
  verifySha256,
  type RsaPrivateNumbers,
} from "./rsa";

// A throwaway 1024-bit test key and `openssl rsautl -encrypt -pkcs` output
// (LibreSSL 3.3.6) for MESSAGE. Not a real key; too small for Nagad on purpose.
const OPENSSL_VECTOR = {
  n: "c652c8c4cef768f4199b2372f46627299d69b573bf769614a2e65361ed6cf66c9c3ce3acfca6dedf217e4c629ba5f6a923ee0642b01fc64c8f6bd7ba3a6f3283494288f6df7e32da0477fe1a71af64a41b3695cac51e64eb03d903ac2f80247ebfbfee477eddcf3335722e3b50a29179507f2f3c687da28fe279d6099b1d0121",
  d: "928fbb2f3684405ba450b1f1d20b6c05a4fee9c99044e2c47d5e1960d5452117429efce26a1427c05dd02842f723bf1560281718517029eb8a51f82af7e4153f016a889eb2979e446a11645956961b8aeef3e3305cb4a77862690327ec780d40a05ae9ae2bba5c13276582713dfb4b305097eb504108deb674e06cfab4330001",
  p: "fb726b405ef25c670b3b9c6ca697a06aa647a4455420c41db5f3f31c19b373fa365706a887dba490d61a1daac057a7ea32e87218d06ecce2904dad90013dee01",
  q: "c9ea1c7ae76feca0c48446ba6bde13b77f987fd5727c8c8532511e57d8bd13acce466e4be2eb75bf5cc2d3ce623816be69e9fabfbbc8a41f0d35b477bbf75321",
  dp: "9ceee99f7062e566eeacd2d1411c6b6384ca3bed85373a0fad0b47952739484e46f203d6d58c3166b029f69026a1cecc2ddfc3ae571080517b6cefc16bf50201",
  dq: "117b2d600ead88051b3e80891f51a8cf5842b1be9f1cdd65a2c79722efe6decf3544afc3ee2f88903acdbb5cc0f02e37ea1f91d00bc8013d96fd3154b4776341",
  qi: "779ea82dc9dfee1a3b1fb89e1aa225994cf643964e43a6c4152e225273f4081f09bac40fc91404450ed7f0cbe97cd308a3214ea4f051e998d7245f02b63bccc7",
  ciphertext: "a9a2f1bbd43c381235ee49937542ce3430711427dbbdce8a2846675c47ac1d7faa96204f914587f32117f9944680abc0b7cbdd7884fef90079521405c252a412df4035f9fc33e6792529106fe796168e96f313dcb7702d1e396ef9d91c889721d4b405583103be0bab0b9d4853d6b3a361b9a0222ac2aee331bc413aec87f134",
  message: "{\"paymentReferenceId\":\"KAT-REF-1\",\"challenge\":\"0123456789abcdef\"}",
};

const big = (hex: string) => BigInt(`0x${hex}`);
const KEY: RsaPrivateNumbers = {
  modulus: big(OPENSSL_VECTOR.n),
  exponent: 65537n,
  length: 128,
  p: big(OPENSSL_VECTOR.p),
  q: big(OPENSSL_VECTOR.q),
  dp: big(OPENSSL_VECTOR.dp),
  dq: big(OPENSSL_VECTOR.dq),
  qi: big(OPENSSL_VECTOR.qi),
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const utf8 = (value: string) => new TextEncoder().encode(value);

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function thrown(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  return null;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Plain square-and-multiply, independent of the module's code.
function power(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  for (const bit of exponent.toString(2)) {
    result = (result * result) % modulus;
    if (bit === "1") result = (result * base) % modulus;
  }
  return result;
}

function rawBlock(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(KEY.length * 2, "0"));
}

/** The textbook private operation (c^d mod n, no CRT): what a correct ciphertext must open to. */
function openRaw(ciphertext: Uint8Array): Uint8Array {
  return rawBlock(power(big(toHex(ciphertext)), big(OPENSSL_VECTOR.d), KEY.modulus));
}

/** Encrypts an arbitrary (possibly malformed) padded block with the public key. */
function sealRaw(block: number[]): Uint8Array {
  return rawBlock(power(big(toHex(Uint8Array.from(block))), KEY.exponent, KEY.modulus));
}

/** 0x00 0x02, `paddingLength` non-zero bytes, then the rest of `tail`, filling exactly k bytes. */
function block(paddingLength: number, tail: number[]): number[] {
  const padding = Array.from({ length: paddingLength }, (_, index) => (index % 250) + 1);
  return [0x00, 0x02, ...padding, ...tail];
}

describe("PKCS#1 v1.5 encryption", () => {
  it("decrypts OpenSSL's ciphertext (CRT path) to the original message", () => {
    expect(text(decryptPkcs1v15(KEY, hexToBytes(OPENSSL_VECTOR.ciphertext)))).toBe(OPENSSL_VECTOR.message);
  });

  it("pads exactly as RFC 8017 7.2.1: 0x00 0x02, at least 8 random non-zero bytes, 0x00, the message", () => {
    const message = utf8("{\"orderId\":\"abc\"}");
    const first = encryptPkcs1v15(KEY, message);
    const opened = openRaw(first);
    const separator = opened.indexOf(0, 2);
    expect(first).toHaveLength(KEY.length);
    expect([opened[0], opened[1]]).toEqual([0x00, 0x02]);
    expect(separator).toBe(KEY.length - message.length - 1);
    expect(opened.slice(2, separator).every((byte) => byte !== 0)).toBe(true);
    expect(opened.slice(separator + 1)).toEqual(message);
    // Random padding: the same message never encrypts the same way twice.
    expect(toHex(encryptPkcs1v15(KEY, message))).not.toBe(toHex(first));
  });

  it("round trips every message length up to k - 11 and refuses a longer one", () => {
    for (const length of [0, 1, 64, KEY.length - 11]) {
      const message = Uint8Array.from({ length }, (_, index) => index % 256);
      expect(decryptPkcs1v15(KEY, encryptPkcs1v15(KEY, message))).toEqual(message);
    }
    const tooLong = thrown(() => encryptPkcs1v15(KEY, new Uint8Array(KEY.length - 10)));
    expect(tooLong instanceof RsaError && tooLong.reason).toBe("message_too_long");
  });

  it("accepts the shortest valid padding (8 bytes)", () => {
    const tail = [0x00, ...Array.from({ length: KEY.length - 11 }, () => 0x41)];
    expect(text(decryptPkcs1v15(KEY, sealRaw(block(8, tail))))).toBe("A".repeat(KEY.length - 11));
  });

  it("rejects every malformed block with the same error", () => {
    const message = Array.from({ length: 20 }, () => 0x41);
    const fill = (start: number[]) => [...start, ...Array.from({ length: KEY.length - start.length }, () => 0x41)];
    const malformed = {
      "signature padding (type 1)": sealRaw([0x00, 0x01, ...Array.from({ length: KEY.length - 23 }, () => 0xff), 0x00, ...message]),
      "padding string of 7 bytes": sealRaw(block(7, [0x00, ...Array.from({ length: KEY.length - 10 }, () => 0x41)])),
      "no separator": sealRaw(fill([0x00, 0x02])),
      "a leading byte other than 0x00": sealRaw(fill([0x01, 0x02, 0x41, 0x00])),
      "one byte short": hexToBytes(OPENSSL_VECTOR.ciphertext).slice(1),
      "a value not below the modulus": new Uint8Array(KEY.length).fill(0xff),
    };
    for (const [name, ciphertext] of Object.entries(malformed)) {
      const caught = thrown(() => decryptPkcs1v15(KEY, ciphertext));
      expect(caught, name).toBeInstanceOf(RsaError);
      expect((caught as RsaError).reason, name).toBe("decryption_failed");
      expect((caught as RsaError).message, name).toBe("The ciphertext does not decrypt with this key.");
    }
  });
});

describe("keys and signatures", () => {
  let pair: KeyPair;

  beforeAll(async () => {
    pair = await generateKeyPair();
  });

  it("imports PEM with or without its lines, with CRLF or literal \\n escapes, to the same numbers", async () => {
    const reference = await importRsaPrivateKey(pair.privatePem);
    const body = pair.privatePem.replace(/-----[A-Z ]+-----/g, "").trim();
    const variants = [body, pair.privatePem.replace(/\n/g, "\r\n"), pair.privatePem.replace(/\n/g, "\\n"), `  ${pair.privatePem}  `];
    for (const variant of variants) {
      const key = await importRsaPrivateKey(variant);
      expect([key.modulus, key.exponent, key.p, key.q, key.qi]).toEqual([reference.modulus, reference.exponent, reference.p, reference.q, reference.qi]);
    }
    const publicKey = await importRsaPublicKey(pair.publicPem.replace(/-----[A-Z ]+-----/g, ""));
    expect(publicKey.modulus).toBe(reference.modulus);
    expect(publicKey.length).toBe(256);
  });

  it("encrypts with the public key and decrypts with the private key at full size", async () => {
    const privateKey = await importRsaPrivateKey(pair.privatePem);
    const publicKey = await importRsaPublicKey(pair.publicPem);
    const message = utf8(JSON.stringify({ merchantId: "683002007104225", orderId: "a".repeat(20), currencyCode: "050", amount: "125.50", challenge: "f".repeat(40) }));
    expect(decryptPkcs1v15(privateKey, encryptPkcs1v15(publicKey, message))).toEqual(message);
  });

  it("signs SHA256withRSA, and verification fails for other data", async () => {
    const privateKey = await importRsaPrivateKey(pair.privatePem);
    const publicKey = await importRsaPublicKey(pair.publicPem);
    const signature = await signSha256(privateKey, utf8("payload"));
    expect(signature).toHaveLength(256);
    expect(await verifySha256(publicKey, signature, utf8("payload"))).toBe(true);
    expect(await verifySha256(publicKey, signature, utf8("payloaD"))).toBe(false);
  });

  it("says why a key is refused", async () => {
    const reasonOf = (work: Promise<unknown>) => work.then(() => "accepted", (error: unknown) => (error instanceof RsaError ? error.reason : "other"));
    const pkcs1 = pair.privatePem.replace(/PRIVATE KEY/g, "RSA PRIVATE KEY");
    const small = await generateKeyPair(1024);
    expect(await reasonOf(importRsaPrivateKey(pkcs1))).toBe("pkcs1");
    expect(await reasonOf(importRsaPublicKey(pair.publicPem.replace(/PUBLIC KEY/g, "RSA PUBLIC KEY")))).toBe("pkcs1");
    expect(await reasonOf(importRsaPublicKey(pair.privatePem))).toBe("unreadable");
    expect(await reasonOf(importRsaPrivateKey(pair.publicPem))).toBe("unreadable");
    expect(await reasonOf(importRsaPrivateKey("not a key"))).toBe("unreadable");
    expect(await reasonOf(importRsaPrivateKey(bytesToBase64(utf8("valid base64, not a key"))))).toBe("unreadable");
    expect(await reasonOf(importRsaPrivateKey(small.privatePem))).toBe("too_small");
    expect(await reasonOf(importRsaPublicKey(small.publicPem))).toBe("too_small");
  });

  it("encodes base64 both ways and refuses anything else", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    expect(base64ToBytes("TmFn\nYWQ=")).toEqual(utf8("Nagad"));
    expect(() => base64ToBytes("Nagad!")).toThrow(RsaError);
    expect(() => base64ToBytes("")).toThrow(RsaError);
  });
});
