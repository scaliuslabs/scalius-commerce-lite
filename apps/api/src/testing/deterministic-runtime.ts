/**
 * A runtime whose counters cannot move between runs (test-only, for the plan budget): every random
 * draw comes from one seeded sequence, and Web Crypto answers in the order it was asked.
 *
 * - Randomness: `Math.random`, Web Crypto's `getRandomValues` and `randomUUID` (ids, tokens, keys)
 *   and SQLite's `random()` and `randomblob()` (event ids written by triggers). An id decides which
 *   due row a bounded drain takes first.
 * - Web Crypto: Node runs `crypto.subtle` off the main thread, so concurrent work (a delivery pass's
 *   lanes, each signing its payload) would resume in whichever order the thread pool finishes, and
 *   the rows a claim reads would depend on it. Each call starts after the one before it settles.
 * - nanoid (`nanoid`, for `vi.mock("nanoid")`): the library refills a module-level pool, so how many
 *   bytes an id draws would depend on the ids every earlier case made. Each id draws its own bytes.
 */
import type { DatabaseSync } from "node:sqlite";
import { vi } from "vitest";

export interface DeterministicRuntime {
  /** Where the random sequence is; `restore` continues from there. */
  state(): number;
  restore(state: number): void;
  /** SQLite's `random()` and `randomblob()` on this connection draw from the sequence too. */
  attach(sqlite: DatabaseSync): void;
  /** Back to the runtime's own randomness and crypto. */
  uninstall(): void;
}

const SUBTLE = ["decrypt", "deriveBits", "deriveKey", "digest", "encrypt", "exportKey", "generateKey", "importKey", "sign", "unwrapKey", "verify", "wrapKey"] as const;

/** Installs the sequence (mulberry32 from `seed`); `mathRandom` maps a draw for `Math.random`. */
export function installDeterministicRuntime(seed: number, mathRandom: (draw: number) => number = (draw) => draw): DeterministicRuntime {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const bytes = (length: number): Uint8Array => Uint8Array.from({ length }, () => Math.floor(next() * 256));
  const subtle = globalThis.crypto.subtle;
  let queue: Promise<unknown> = Promise.resolve();
  const spies = [
    vi.spyOn(Math, "random").mockImplementation(() => mathRandom(next())),
    vi.spyOn(globalThis.crypto, "getRandomValues").mockImplementation(<T extends ArrayBufferView | null>(array: T): T => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).set(bytes(array.byteLength));
      return array;
    }),
    vi.spyOn(globalThis.crypto, "randomUUID").mockImplementation(() => {
      const value = bytes(16);
      value[6] = (value[6]! & 0x0f) | 0x40;
      value[8] = (value[8]! & 0x3f) | 0x80;
      const hex = [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`;
    }),
    ...SUBTLE.map((name) => {
      const original = (subtle[name] as (...args: unknown[]) => Promise<unknown>).bind(subtle);
      return vi.spyOn(subtle, name).mockImplementation(((...args: unknown[]) => {
        const answer = queue.then(() => original(...args));
        queue = answer.catch(() => undefined);
        return answer;
      }) as never);
    }),
  ];
  return {
    state: () => state,
    restore: (saved) => { state = saved; },
    attach(sqlite) {
      sqlite.function("random", () => BigInt.asIntN(64, (BigInt(Math.floor(next() * 2 ** 32)) << 32n) | BigInt(Math.floor(next() * 2 ** 32))));
      sqlite.function("randomblob", (length) => bytes(Math.max(1, Number(length))));
    },
    uninstall: () => { for (const spy of spies) spy.mockRestore(); },
  };
}

/** nanoid's URL alphabet: each id draws its own bytes from Web Crypto (no pool kept between ids). */
export function nanoid(size = 21): string {
  const alphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
  return [...crypto.getRandomValues(new Uint8Array(size))].map((byte) => alphabet[byte & 63]).join("");
}
