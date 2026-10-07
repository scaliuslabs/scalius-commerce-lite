// What a country implies for a new store (Unicode CLDR supplemental data):
// its currency and its unit system. Only the store setup step and the store
// setup service load this table. Pure, browser-safe.
import { SUPPORTED_CURRENCY_CODES, type SupportedCurrencyCode } from "./currency-policy";
import type { UnitSystem } from "./store-defaults";

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_CURRENCY_CODES);

/**
 * Each territory's current legal tender (CLDR `currencyData/region`: the
 * newest entry without an end date). Territories without one of their own
 * are absent and default to USD.
 */
const COUNTRY_CURRENCY: Readonly<Record<string, string>> = {
  AC: "SHP", AD: "EUR", AE: "AED", AF: "AFN", AG: "XCD", AI: "XCD", AL: "ALL", AM: "AMD", AO: "AOA",
  AR: "ARS", AS: "USD", AT: "EUR", AU: "AUD", AW: "AWG", AX: "EUR", AZ: "AZN", BA: "BAM", BB: "BBD",
  BD: "BDT", BE: "EUR", BF: "XOF", BG: "BGN", BH: "BHD", BI: "BIF", BJ: "XOF", BL: "EUR", BM: "BMD",
  BN: "BND", BO: "BOB", BQ: "USD", BR: "BRL", BS: "BSD", BT: "BTN", BV: "NOK", BW: "BWP", BY: "BYN",
  BZ: "BZD", CA: "CAD", CC: "AUD", CD: "CDF", CF: "XAF", CG: "XAF", CH: "CHF", CI: "XOF", CK: "NZD",
  CL: "CLP", CM: "XAF", CN: "CNY", CO: "COP", CR: "CRC", CU: "CUP", CV: "CVE", CW: "ANG", CX: "AUD",
  CY: "EUR", CZ: "CZK", DE: "EUR", DG: "USD", DJ: "DJF", DK: "DKK", DM: "XCD", DO: "DOP", DZ: "DZD",
  EA: "EUR", EC: "USD", EE: "EUR", EG: "EGP", EH: "MAD", ER: "ERN", ES: "EUR", ET: "ETB", FI: "EUR",
  FJ: "FJD", FK: "FKP", FM: "USD", FO: "DKK", FR: "EUR", GA: "XAF", GB: "GBP", GD: "XCD", GE: "GEL",
  GF: "EUR", GG: "GBP", GH: "GHS", GI: "GIP", GL: "DKK", GM: "GMD", GN: "GNF", GP: "EUR", GQ: "XAF",
  GR: "EUR", GS: "GBP", GT: "GTQ", GU: "USD", GW: "XOF", GY: "GYD", HK: "HKD", HM: "AUD", HN: "HNL",
  HR: "EUR", HT: "HTG", HU: "HUF", IC: "EUR", ID: "IDR", IE: "EUR", IL: "ILS", IM: "GBP", IN: "INR",
  IO: "USD", IQ: "IQD", IR: "IRR", IS: "ISK", IT: "EUR", JE: "GBP", JM: "JMD", JO: "JOD", JP: "JPY",
  KE: "KES", KG: "KGS", KH: "KHR", KI: "AUD", KM: "KMF", KN: "XCD", KP: "KPW", KR: "KRW", KW: "KWD",
  KY: "KYD", KZ: "KZT", LA: "LAK", LB: "LBP", LC: "XCD", LI: "CHF", LK: "LKR", LR: "LRD", LS: "ZAR",
  LT: "EUR", LU: "EUR", LV: "EUR", LY: "LYD", MA: "MAD", MC: "EUR", MD: "MDL", ME: "EUR", MF: "EUR",
  MG: "MGA", MH: "USD", MK: "MKD", ML: "XOF", MM: "MMK", MN: "MNT", MO: "MOP", MP: "USD", MQ: "EUR",
  MR: "MRU", MS: "XCD", MT: "EUR", MU: "MUR", MV: "MVR", MW: "MWK", MX: "MXN", MY: "MYR", MZ: "MZN",
  NA: "NAD", NC: "XPF", NE: "XOF", NF: "AUD", NG: "NGN", NI: "NIO", NL: "EUR", NO: "NOK", NP: "NPR",
  NR: "AUD", NU: "NZD", NZ: "NZD", OM: "OMR", PA: "PAB", PE: "PEN", PF: "XPF", PG: "PGK", PH: "PHP",
  PK: "PKR", PL: "PLN", PM: "EUR", PN: "NZD", PR: "USD", PS: "ILS", PT: "EUR", PW: "USD", PY: "PYG",
  QA: "QAR", RE: "EUR", RO: "RON", RS: "RSD", RU: "RUB", RW: "RWF", SA: "SAR", SB: "SBD", SC: "SCR",
  SD: "SDG", SE: "SEK", SG: "SGD", SH: "SHP", SI: "EUR", SJ: "NOK", SK: "EUR", SL: "SLE", SM: "EUR",
  SN: "XOF", SO: "SOS", SR: "SRD", SS: "SSP", ST: "STN", SV: "USD", SX: "ANG", SY: "SYP", SZ: "SZL",
  TA: "GBP", TC: "USD", TD: "XAF", TF: "EUR", TG: "XOF", TH: "THB", TJ: "TJS", TK: "NZD", TL: "USD",
  TM: "TMT", TN: "TND", TO: "TOP", TR: "TRY", TT: "TTD", TV: "AUD", TW: "TWD", TZ: "TZS", UA: "UAH",
  UG: "UGX", UM: "USD", US: "USD", UY: "UYU", UZ: "UZS", VA: "EUR", VC: "XCD", VE: "VES", VG: "USD",
  VI: "USD", VN: "VND", VU: "VUV", WF: "XPF", WS: "WST", XK: "EUR", YE: "YER", YT: "EUR", ZA: "ZAR",
  ZM: "ZMW", ZW: "ZWL",
};

/** CLDR `measurementData`: the territories whose measurement system is US customary. */
const IMPERIAL_COUNTRIES: ReadonlySet<string> = new Set(["US", "LR"]);

/** The currency a new store in `country` sells in: its CLDR tender when supported, else USD. */
export function defaultCurrencyForCountry(country: string): SupportedCurrencyCode {
  const code = COUNTRY_CURRENCY[country.trim().toUpperCase()];
  return code && SUPPORTED.has(code) ? code as SupportedCurrencyCode : "USD";
}

/** The unit system a new store in `country` uses (CLDR). */
export function defaultUnitSystemForCountry(country: string): UnitSystem {
  return IMPERIAL_COUNTRIES.has(country.trim().toUpperCase()) ? "imperial" : "metric";
}

/** A currency's narrow symbol (`$`, `€`, `৳`), else its code. */
export { currencySymbol as defaultCurrencySymbol } from "./money-format";
