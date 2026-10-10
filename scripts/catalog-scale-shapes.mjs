/**
 * catalog-scale-shapes.mjs — the pure parts of the large-store seed
 * (`scripts/catalog-scale-seed.mjs`): profiles, the seeded random stream, the
 * seasonal order clock, order money and the order lifecycle. Nothing here
 * touches a database, so `catalog-scale-shapes.test.ts` can prove the shapes
 * and invariants on a tiny profile in milliseconds.
 */

export const DAY = 86400;

/** Profiles. `default` is the long-standing Startech-scale shape; `huge` is "hundreds of thousands of products, millions of orders" in proportion. */
export const PROFILES = {
  default: {
    name: "default",
    huge: false,
    products: 30000,
    customers: 20000,
    orders: 50000,
    categories: 400,
    brands: 300,
    qualifiersPerFamily: 5,
    banglaRate: 0.08,
    optionedRate: 0.7,
  },
  huge: {
    name: "huge",
    huge: true,
    products: 50000,
    customers: 200000,
    orders: 1000000,
    categories: 800,
    brands: 500,
    qualifiersPerFamily: 10,
    banglaRate: 0.2,
    optionedRate: 0.85,
    reviews: 100000,
    promotions: 2000,
    giftCards: 3000,
    conversations: 20000,
    messages: 150000,
    staff: 15,
    auditEvents: 60000,
    notificationRate: 0.05,
    eventRate: 0.15,
    orderWindowDays: 1095,
  },
};

export function resolveProfile(name, overrides = {}) {
  const base = PROFILES[name];
  if (!base) throw new Error(`Unknown profile "${name}". Use one of: ${Object.keys(PROFILES).join(", ")}.`);
  const profile = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined && Number.isFinite(value)) profile[key] = value;
  }
  return profile;
}

// ---------------------------------------------------------------- randomness
/** mulberry32: the same stream the seed has always drawn from. */
export function createRng(seed) {
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min, max) => min + Math.floor(rand() * (max - min + 1));
  const pick = (list) => list[Math.floor(rand() * list.length)];
  const chance = (p) => rand() < p;
  const weighted = (entries) => {
    let total = 0;
    for (const [, weight] of entries) total += weight;
    let roll = rand() * total;
    for (const [value, weight] of entries) {
      roll -= weight;
      if (roll < 0) return value;
    }
    return entries[entries.length - 1][0];
  };
  return { rand, int, pick, chance, weighted };
}

export const pad = (n, width) => String(n).padStart(width, "0");

// ------------------------------------------------------------------- seasons
// Bangladesh e-commerce shape: Eid-season peaks (spring and early summer),
// the 11.11 and December campaigns, a dull monsoon, Friday-heavy evenings, and
// a store that grows year over year.
const MONTH_WEIGHT = [0.95, 0.9, 1.25, 1.35, 1.0, 1.15, 1.2, 0.85, 0.85, 1.0, 1.4, 1.45];
const WEEKDAY_WEIGHT = [1.0, 0.95, 0.95, 1.0, 1.05, 1.3, 1.15]; // Sunday..Saturday
const HOUR_WEIGHT = [0.3, 0.2, 0.15, 0.1, 0.1, 0.2, 0.4, 0.7, 1.0, 1.3, 1.5, 1.5, 1.4, 1.3, 1.4, 1.5, 1.6, 1.8, 2.0, 2.2, 2.0, 1.6, 1.0, 0.6];

/** Cumulative day weights over `days` days ending at `endTs` (the last day is the newest). */
export function buildClock(endTs, days) {
  const startTs = endTs - days * DAY;
  const cumulative = new Float64Array(days);
  let total = 0;
  for (let day = 0; day < days; day += 1) {
    const date = new Date((startTs + day * DAY) * 1000);
    const growth = 0.55 + (0.9 * day) / Math.max(1, days - 1);
    // Campaign spikes: 11.11 and the last week of December.
    const month = date.getUTCMonth();
    const dom = date.getUTCDate();
    const spike = (month === 10 && dom >= 9 && dom <= 12) || (month === 11 && dom >= 24) ? 1.8 : 1;
    total += MONTH_WEIGHT[month] * WEEKDAY_WEIGHT[date.getUTCDay()] * growth * spike;
    cumulative[day] = total;
  }
  const hourTotal = HOUR_WEIGHT.reduce((sum, weight) => sum + weight, 0);
  return { startTs, endTs, days, cumulative, total, hourTotal };
}

/** A timestamp (epoch seconds) drawn from the seasonal clock. */
export function sampleTime(rng, clock) {
  const target = rng.rand() * clock.total;
  let lo = 0;
  let hi = clock.days - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clock.cumulative[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  let roll = rng.rand() * clock.hourTotal;
  let hour = 0;
  for (; hour < 23; hour += 1) {
    roll -= HOUR_WEIGHT[hour];
    if (roll < 0) break;
  }
  return Math.min(clock.endTs - 1, clock.startTs + lo * DAY + hour * 3600 + rng.int(0, 3599));
}

// --------------------------------------------------------------------- money
/** Integer-only half-up division of non-negative numerators. */
export const divRound = (numerator, denominator) => Math.floor((numerator * 2 + denominator) / (denominator * 2));

/** 1 / rate as a decimal string with at most 12 fraction digits, half up (BigInt, exact). */
export function invertRate(rate) {
  const [whole, fraction = ""] = rate.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) throw new RangeError("rate must be positive");
  const digits = 10n ** 12n;
  const scaled = (scale * digits * 2n + numerator) / (numerator * 2n);
  const text = scaled.toString().padStart(13, "0");
  const out = `${text.slice(0, -12)}.${text.slice(-12)}`.replace(/0+$/, "").replace(/\.$/, "");
  return out;
}

/** `amount` (minor units) × decimal `rate` string, half up, exact. */
export function convertMinor(amount, rate) {
  if (rate === "1") return amount;
  const [whole, fraction = ""] = rate.split(".");
  const scale = 10n ** BigInt(fraction.length);
  const numerator = BigInt(amount) * BigInt(whole + fraction);
  return Number((numerator * 2n + scale) / (scale * 2n));
}

/**
 * Splits a percentage discount over lines, in whole minor units. A line never
 * discounts below one minor unit left to pay.
 */
export function lineDiscounts(lineSubtotals, bps) {
  return lineSubtotals.map((subtotal) => Math.min(Math.max(0, subtotal - 1), Math.floor((subtotal * bps) / 10000)));
}

/**
 * Prices an order in minor units. `lines` carry `unit` and `qty`; the result
 * keeps every identity the stores relies on:
 *   total = subtotal - discount + tax + shipping
 *   (tax-exclusive prices; `taxBps` 0 means no tax)
 */
export function priceOrder({ lines, shipping, discountBps = 0, taxBps = 0 }) {
  const subtotals = lines.map((line) => line.unit * line.qty);
  const discounts = discountBps > 0 ? lineDiscounts(subtotals, discountBps) : subtotals.map(() => 0);
  const taxes = subtotals.map((subtotal, index) => (taxBps > 0 ? divRound((subtotal - discounts[index]) * taxBps, 10000) : 0));
  const subtotal = subtotals.reduce((sum, value) => sum + value, 0);
  const discount = discounts.reduce((sum, value) => sum + value, 0);
  const tax = taxes.reduce((sum, value) => sum + value, 0);
  return {
    lines: lines.map((line, index) => ({ ...line, subtotal: subtotals[index], discount: discounts[index], tax: taxes[index], taxable: subtotals[index] - discounts[index] })),
    subtotal,
    discount,
    tax,
    shipping,
    total: subtotal - discount + tax + shipping,
  };
}

// ----------------------------------------------------------------- lifecycle
const STATUS_BY_AGE = {
  fresh: [["pending", 35], ["processing", 25], ["confirmed", 20], ["shipped", 10], ["delivered", 5], ["cancelled", 5]],
  recent: [["pending", 3], ["processing", 5], ["confirmed", 5], ["shipped", 25], ["delivered", 40], ["completed", 12], ["cancelled", 7], ["returned", 3]],
  settled: [["pending", 0.4], ["cancelled", 7], ["returned", 3.5], ["completed", 62], ["delivered", 27.1]],
};

/**
 * Decides how an order of `ageDays` ended up. `online` orders were paid at
 * checkout; cash-on-delivery orders are paid when the parcel is delivered.
 * Returns the order's states and what it owes the child tables.
 */
export function pickLifecycle(rng, ageDays, online) {
  const band = ageDays < 3 ? "fresh" : ageDays < 14 ? "recent" : "settled";
  const status = rng.weighted(STATUS_BY_AGE[band]);
  const shipped = status === "shipped" || status === "delivered" || status === "completed" || status === "returned";
  const delivered = status === "delivered" || status === "completed";
  let payment = "unpaid";
  if (online) {
    if (status === "cancelled") payment = rng.chance(0.3) ? "refunded" : rng.chance(0.5) ? "failed" : "unpaid";
    else if (status === "returned") payment = "refunded";
    else payment = rng.chance(0.93) ? "paid" : rng.chance(0.5) ? "unpaid" : "failed";
  } else if (delivered) payment = rng.chance(0.97) ? "paid" : "partial";
  else if (status === "returned") payment = "unpaid";
  else if (!shipped && status !== "cancelled" && rng.chance(0.03)) payment = "partial";
  let fulfillment = shipped ? "complete" : "pending";
  if (status === "shipped" && rng.chance(0.08)) fulfillment = "partial";
  // A partial return of a delivered order, refunded in part.
  const partialReturn = delivered && payment === "paid" && rng.chance(0.03);
  const fullReturn = status === "returned";
  return { status, payment, fulfillment, delivered, partialReturn, fullReturn };
}

/** The payment state the refund service derives from captured and refunded money. */
export function paymentLedgerState({ total, captured, refunded }) {
  if (captured > 0 && refunded >= captured) return { paid: 0, balance: 0, status: "refunded" };
  if (refunded > 0 && captured >= total) return { paid: captured - refunded, balance: 0, status: "partially_refunded" };
  const paid = captured - refunded;
  if (paid <= 0) return { paid: 0, balance: total, status: "unpaid" };
  if (paid >= total) return { paid, balance: 0, status: "paid" };
  return { paid, balance: total - paid, status: "partial" };
}

/**
 * Plans how many orders each customer places: one whale with `whaleOrders`, a
 * handful of heavy buyers, then a skewed long tail. Returns a function from the
 * order index to a customer index, consuming the given stream.
 */
export function createCustomerPicker(rng, { customers, orders, whaleOrders = 500, heavyCustomers = 20 }) {
  const whaleTarget = Math.min(whaleOrders, Math.floor(orders / 20));
  const stride = whaleTarget > 0 ? Math.max(1, Math.floor(orders / whaleTarget)) : 0;
  let whaleCount = 0;
  const heavyEnd = Math.min(heavyCustomers, Math.max(0, customers - 1));
  const tailStart = 1 + heavyEnd;
  return (orderIndex) => {
    if (stride > 0 && orderIndex % stride === 0 && whaleCount < whaleTarget) {
      whaleCount += 1;
      return 0;
    }
    if (heavyEnd > 0 && rng.chance(0.0015)) return 1 + rng.int(0, heavyEnd - 1);
    const span = Math.max(1, customers - tailStart);
    return tailStart + Math.min(span - 1, Math.floor(span * rng.rand() ** 1.8));
  };
}

/** Popularity-skewed index over `count` items: low indexes are bestsellers. */
export function popularIndex(rng, count) {
  return Math.min(count - 1, Math.floor(count * rng.rand() ** 2.4));
}

/** Pads `base` with plausible merchant copy until it is at least `minLength` characters. */
export function padName(base, minLength, filler) {
  let out = base;
  let i = 0;
  while (out.length < minLength) {
    out += ` ${filler[i % filler.length]}`;
    i += 1;
  }
  return out;
}
