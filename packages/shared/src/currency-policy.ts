// Currency policy (docs/MARKETS-DESIGN.md, D1). Three facts per currency that
// platforms which merged them got wrong, kept apart:
//
// - exponent: the ISO 4217 minor unit. Money is stored and computed as
//   integers of 10^-exponent (BDT 2: paisa; JPY 0; KWD 3: fils).
// - cash increment: CLDR's cash rounding, in minor units — the smallest
//   amount coins and notes can pay (CHF 5 = 0.05, DKK 50, SEK 100).
// - display digits: CLDR's fraction digits for a formatted amount (IQD shows
//   none although ISO counts fils).
//
// Whole taka is none of these (CLDR has no BDT entry): it is the default
// *price increment* of a BDT market and the *cash increment* of cash on
// delivery in BDT, two Scalius policies defined below.

export const SUPPORTED_CURRENCY_CODES = [
  "USD", "EUR", "GBP", "JPY", "CHF", "CAD", "AUD", "NZD", "CNY", "HKD", "SGD", "SEK",
  "NOK", "DKK", "MXN", "BRL", "BDT", "INR", "PKR", "LKR", "NPR", "AFN", "BTN", "MVR",
  "MYR", "PHP", "THB", "IDR", "VND", "MMK", "KHR", "LAK", "BND", "KRW", "TWD", "MNT",
  "KPW", "MOP", "AED", "SAR", "QAR", "KWD", "BHD", "OMR", "JOD", "IQD", "IRR", "YER",
  "LBP", "SYP", "ILS", "KZT", "UZS", "KGS", "TJS", "TMT", "GEL", "AMD", "AZN", "TRY",
  "RUB", "UAH", "PLN", "CZK", "HUF", "RON", "BGN", "HRK", "RSD", "BAM", "MKD", "ALL",
  "MDL", "BYN", "ISK", "ARS", "CLP", "COP", "PEN", "UYU", "PYG", "BOB", "VES", "GYD",
  "SRD", "TTD", "JMD", "BBD", "BSD", "BZD", "CRC", "CUP", "DOP", "GTQ", "HNL", "HTG",
  "NIO", "PAB", "AWG", "ANG", "KYD", "BMD", "XCD", "FKP", "NGN", "GHS", "XOF", "GMD",
  "GNF", "SLL", "LRD", "CVE", "MRU", "KES", "TZS", "UGX", "RWF", "BIF", "ETB", "SOS",
  "ERN", "DJF", "SDG", "SSP", "SCR", "KMF", "MGA", "MUR", "XAF", "CDF", "ZAR", "BWP",
  "LSL", "SZL", "NAD", "MWK", "ZMW", "MZN", "AOA", "ZWL", "EGP", "DZD", "MAD", "TND",
  "LYD", "STN", "FJD", "PGK", "WST", "TOP", "VUV", "SBD", "XPF", "XDR", "XAG", "XAU",
] as const;

export type SupportedCurrencyCode = (typeof SUPPORTED_CURRENCY_CODES)[number];

/**
 * ISO 4217 currencies with a four-decimal minor unit (Chile's Unidad de
 * Fomento, Uruguay's wage index unit). They are units of account, not
 * currencies a store sells in, and every money path is built for exponents
 * 0–3 (`toMinor` refuses anything else), so they are left out of
 * `SUPPORTED_CURRENCY_CODES` on purpose rather than by accident.
 */
export const EXCLUDED_CURRENCY_CODES = ["CLF", "UYW"] as const;

export interface CurrencyPolicy {
  code: string;
  /** ISO 4217 minor-unit exponent: storage integers are 10^-exponent of a unit. */
  exponent: number;
  /** CLDR cash rounding in minor units: the smallest amount cash can pay. */
  cashIncrementMinor: number;
  /** CLDR fraction digits of a formatted amount. */
  displayDigits: number;
}

/**
 * `[exponent, cashIncrementMinor, displayDigits]` for every supported code.
 * Exponents are ISO 4217; cash increments and display digits are CLDR
 * `supplementalData.xml` `currencyData/fractions` (cashRounding ×
 * 10^(exponent − cashDigits); a currency CLDR does not list uses its
 * default: two digits, no cash rounding). XDR, XAG and XAU have no ISO minor
 * unit and keep the default.
 */
const CURRENCY_POLICY_TABLE: Readonly<Record<SupportedCurrencyCode, readonly [number, number, number]>> = {
  USD: [2, 1, 2], EUR: [2, 1, 2], GBP: [2, 1, 2], JPY: [0, 1, 0], CHF: [2, 5, 2], CAD: [2, 5, 2],
  AUD: [2, 1, 2], NZD: [2, 1, 2], CNY: [2, 1, 2], HKD: [2, 1, 2], SGD: [2, 1, 2], SEK: [2, 100, 2],
  NOK: [2, 100, 2], DKK: [2, 50, 2], MXN: [2, 1, 2], BRL: [2, 1, 2], BDT: [2, 1, 2], INR: [2, 1, 2],
  PKR: [2, 100, 2], LKR: [2, 1, 2], NPR: [2, 1, 2], AFN: [2, 100, 0], BTN: [2, 1, 2], MVR: [2, 1, 2],
  MYR: [2, 1, 2], PHP: [2, 1, 2], THB: [2, 1, 2], IDR: [2, 100, 2], VND: [0, 1, 0], MMK: [2, 100, 0],
  KHR: [2, 1, 2], LAK: [2, 100, 0], BND: [2, 1, 2], KRW: [0, 1, 0], TWD: [2, 100, 2], MNT: [2, 100, 2],
  KPW: [2, 100, 0], MOP: [2, 1, 2], AED: [2, 1, 2], SAR: [2, 1, 2], QAR: [2, 1, 2], KWD: [3, 1, 3],
  BHD: [3, 1, 3], OMR: [3, 1, 3], JOD: [3, 1, 3], IQD: [3, 1000, 0], IRR: [2, 100, 0], YER: [2, 100, 0],
  LBP: [2, 100, 0], SYP: [2, 100, 0], ILS: [2, 1, 2], KZT: [2, 1, 2], UZS: [2, 100, 2], KGS: [2, 1, 2],
  TJS: [2, 1, 2], TMT: [2, 1, 2], GEL: [2, 1, 2], AMD: [2, 100, 2], AZN: [2, 1, 2], TRY: [2, 1, 2],
  RUB: [2, 1, 2], UAH: [2, 1, 2], PLN: [2, 1, 2], CZK: [2, 100, 2], HUF: [2, 100, 2], RON: [2, 1, 2],
  BGN: [2, 1, 2], HRK: [2, 1, 2], RSD: [2, 100, 0], BAM: [2, 1, 2], MKD: [2, 1, 2], ALL: [2, 100, 0],
  MDL: [2, 1, 2], BYN: [2, 1, 2], ISK: [0, 1, 0], ARS: [2, 1, 2], CLP: [0, 1, 0], COP: [2, 100, 2],
  PEN: [2, 1, 2], UYU: [2, 1, 2], PYG: [0, 1, 0], BOB: [2, 1, 2], VES: [2, 1, 2], GYD: [2, 100, 2],
  SRD: [2, 1, 2], TTD: [2, 1, 2], JMD: [2, 1, 2], BBD: [2, 1, 2], BSD: [2, 1, 2], BZD: [2, 1, 2],
  CRC: [2, 100, 2], CUP: [2, 1, 2], DOP: [2, 1, 2], GTQ: [2, 1, 2], HNL: [2, 1, 2], HTG: [2, 1, 2],
  NIO: [2, 1, 2], PAB: [2, 1, 2], AWG: [2, 1, 2], ANG: [2, 1, 2], KYD: [2, 1, 2], BMD: [2, 1, 2],
  XCD: [2, 1, 2], FKP: [2, 1, 2], NGN: [2, 1, 2], GHS: [2, 1, 2], XOF: [0, 1, 0], GMD: [2, 1, 2],
  GNF: [0, 1, 0], SLL: [2, 100, 0], LRD: [2, 1, 2], CVE: [2, 1, 2], MRU: [2, 1, 2], KES: [2, 1, 2],
  TZS: [2, 100, 2], UGX: [0, 1, 0], RWF: [0, 1, 0], BIF: [0, 1, 0], ETB: [2, 1, 2], SOS: [2, 100, 0],
  ERN: [2, 1, 2], DJF: [0, 1, 0], SDG: [2, 1, 2], SSP: [2, 1, 2], SCR: [2, 1, 2], KMF: [0, 1, 0],
  MGA: [2, 100, 0], MUR: [2, 100, 2], XAF: [0, 1, 0], CDF: [2, 1, 2], ZAR: [2, 1, 2], BWP: [2, 1, 2],
  LSL: [2, 1, 2], SZL: [2, 1, 2], NAD: [2, 1, 2], MWK: [2, 1, 2], ZMW: [2, 1, 2], MZN: [2, 1, 2],
  AOA: [2, 1, 2], ZWL: [2, 1, 2], EGP: [2, 1, 2], DZD: [2, 1, 2], MAD: [2, 1, 2], TND: [3, 1, 3],
  LYD: [3, 1, 3], STN: [2, 1, 2], FJD: [2, 1, 2], PGK: [2, 1, 2], WST: [2, 1, 2], TOP: [2, 1, 2],
  VUV: [0, 1, 0], SBD: [2, 1, 2], XPF: [0, 1, 0], XDR: [2, 1, 2], XAG: [2, 1, 2], XAU: [2, 1, 2],
};

/** Codes outside the table: ISO's four-decimal units keep their exponent (and are refused by `toMinor`). */
const EXCLUDED_EXPONENT = 4;
const DEFAULT_ROW = [2, 1, 2] as const;

function rowOf(code: string): readonly [number, number, number] {
  const normalized = code.trim().toUpperCase();
  if ((EXCLUDED_CURRENCY_CODES as readonly string[]).includes(normalized)) return [EXCLUDED_EXPONENT, 1, EXCLUDED_EXPONENT];
  return CURRENCY_POLICY_TABLE[normalized as SupportedCurrencyCode] ?? DEFAULT_ROW;
}

/** A currency's policy; an unknown code has the ISO default (two decimals, no cash rounding). */
export function currencyPolicy(code: string): CurrencyPolicy {
  const [exponent, cashIncrementMinor, displayDigits] = rowOf(code);
  return { code: code.trim().toUpperCase(), exponent, cashIncrementMinor, displayDigits };
}

/** The ISO 4217 exponent (`getDecimalPlaces` in ./currency). */
export function currencyExponent(code: string): number {
  return rowOf(code)[0];
}

// ---------------------------------------------------------------------------
// Price increment: a market policy
// ---------------------------------------------------------------------------

/**
 * A market's price increment, in minor units: every price a merchant enters
 * and every amount derived from prices (percentage discounts, app
 * discounts, bundle and EMI prices, tax) is a multiple of it. Until Markets
 * step 2 adds the `markets` table it is the store's (the default market's)
 * setting in the currency document.
 *
 * The default is Scalius policy, not a currency fact: a BDT market prices in
 * whole taka (100), every other currency in its minor unit (1). A merchant
 * may choose the minor unit or the whole unit (`priceIncrementChoices`).
 */
export function defaultPriceIncrementMinor(code: string): number {
  return code.trim().toUpperCase() === "BDT" ? 10 ** currencyExponent("BDT") : 1;
}

/** The increments a merchant can choose: the minor unit, and the whole unit when it differs. */
export function priceIncrementChoices(code: string): readonly number[] {
  const whole = 10 ** currencyExponent(code);
  return whole === 1 ? [1] : [1, whole];
}

export function isPriceIncrementMinor(code: string, value: unknown): value is number {
  return typeof value === "number" && priceIncrementChoices(code).includes(value);
}

/** A stored increment when it is a choice for the currency, else the currency's default. */
export function resolvePriceIncrementMinor(code: string, stored: unknown): number {
  return isPriceIncrementMinor(code, stored) ? stored : defaultPriceIncrementMinor(code);
}

/** A currency as pricing needs it: its ISO exponent and the market's price increment. */
export interface PricingCurrency {
  code: string;
  decimalPlaces: number;
  priceIncrementMinor: number;
}

/** True when the increment is the currency's whole unit (BDT 100: "Taka amounts are whole numbers."). */
export function isWholeUnitIncrement(code: string, incrementMinor: number): boolean {
  return incrementMinor > 1 && incrementMinor === 10 ** currencyExponent(code);
}

// ---------------------------------------------------------------------------
// Cash increment of a payment method
// ---------------------------------------------------------------------------

/**
 * What cash collection (cash on delivery, cash at a counter) can take, in
 * minor units (MARKETS-DESIGN step 6): riders and couriers in Bangladesh
 * collect whole taka (100); every other currency collects its CLDR cash
 * increment (CHF and CAD 0.05, DKK 0.50, SEK whole kronor), else its minor
 * unit. An amount off it is refused before an order commits (the amount
 * codec), never rounded silently.
 */
export function cashIncrementMinor(code: string): number {
  const normalized = code.trim().toUpperCase();
  return normalized === "BDT" ? 10 ** currencyExponent("BDT") : currencyPolicy(normalized).cashIncrementMinor;
}

/** Cash on delivery's increment: the currency's cash increment (`cashIncrementMinor`). */
export function cashOnDeliveryIncrementMinor(code: string): number {
  return cashIncrementMinor(code);
}
