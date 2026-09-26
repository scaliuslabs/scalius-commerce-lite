/**
 * Seeded randomness for the DVC property harness. Every random choice of a run
 * (mutations, reads, time, scheduling, ids minted by services) comes from one
 * seed, so `DVC_SEED=<seed>` replays a failing run exactly.
 */

function hashSeed(seed: string): number {
  let h = 2166136261 >>> 0;
  for (let index = 0; index < seed.length; index += 1) {
    h ^= seed.charCodeAt(index);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

export class Rng {
  private state: number;

  constructor(readonly seed: string) {
    this.state = hashSeed(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("Rng.pick on an empty list");
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted choice over `[weight, value]` pairs. */
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((sum, [weight]) => sum + weight, 0);
    let roll = this.next() * total;
    for (const [weight, value] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1]![1];
  }

  sample<T>(items: readonly T[], count: number): T[] {
    const copy = [...items];
    const out: T[] = [];
    while (out.length < count && copy.length > 0) out.push(copy.splice(Math.floor(this.next() * copy.length), 1)[0]!);
    return out;
  }

  /** An independent stream for one concern, stable under changes to the others. */
  fork(label: string): Rng {
    return new Rng(`${this.seed}/${label}`);
  }

  /** Fill a byte array (seeded `crypto.getRandomValues` for replayable ids). */
  fill(bytes: Uint8Array): void {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(this.next() * 256);
  }
}
