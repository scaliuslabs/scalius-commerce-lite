import { mcpRequest } from "./mcp-client.js";
import type { ResolvedProfile, Runtime } from "./types.js";

// Money in flags is what a merchant says: `--set 1500` is 1,500 taka. The store
// tells the CLI its currency and decimal places (`scalius://store`), and this
// file converts an exact decimal string to integer minor units with the same
// rule as `toMinor` in @scalius/shared/money (the published CLI cannot import
// the workspace package). `--minor` bypasses all of it.

export interface StoreMoney {
  code: string;
  /** Decimal places of the currency: 2 for BDT, 0 for JPY, 3 for KWD. */
  decimals: number;
}

const MAX_MINOR = 9_000_000_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO 4217 decimal places of a currency code, from the runtime's ICU data. */
export function currencyDecimals(code: string): number | undefined {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
    return typeof digits === "number" && digits >= 0 && digits <= 3 ? digits : undefined;
  } catch {
    return undefined;
  }
}

/** The store's currency and its decimal places, or undefined when the store does not say. */
export async function readStoreMoney(runtime: Runtime, profile: ResolvedProfile): Promise<StoreMoney | undefined> {
  try {
    const resource = await mcpRequest(runtime, profile, "dashboard", "resources/read", { uri: "scalius://store" }, { retry: true, maxAttempts: 2 });
    const contents = Array.isArray(resource.contents) ? resource.contents.filter(isRecord) : [];
    const store = JSON.parse(String(contents[0]?.text ?? "{}")) as Record<string, unknown>;
    const code = typeof store.currency === "string" ? store.currency.trim().toUpperCase() : "";
    if (!/^[A-Z]{3}$/.test(code)) return undefined;
    const reported = store.decimals;
    const decimals = typeof reported === "number" && Number.isInteger(reported) && reported >= 0 && reported <= 3 ? reported : currencyDecimals(code);
    return decimals === undefined ? undefined : { code, decimals };
  } catch {
    return undefined;
  }
}

/**
 * An amount a merchant typed (`1500`, `1500.50`, `-100`) as integer minor
 * units of the store currency. Exact: it works on the digits, never on a float.
 * Throws a RangeError whose message is safe to show.
 */
export function amountToMinor(text: string, money: StoreMoney, flag: string, options: { signed: boolean }): number {
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!match) {
    const example = money.decimals > 0 ? `1500.${"5".padEnd(money.decimals, "0")}` : "1500";
    throw new RangeError(`--${flag} must be an amount in ${money.code}, like ${example}, got '${text}'. Use --minor for minor units.`);
  }
  const [, sign, whole = "0", fraction = ""] = match;
  if (sign === "-" && !options.signed) throw new RangeError(`--${flag} must not be negative.`);
  if (/[^0]/.test(fraction.slice(money.decimals))) {
    throw new RangeError(`${money.code} has ${money.decimals} decimal place${money.decimals === 1 ? "" : "s"}; --${flag} '${text}' has more. Use --minor for minor units.`);
  }
  const minor = Number(`${whole}${fraction.slice(0, money.decimals).padEnd(money.decimals, "0")}`);
  if (!Number.isSafeInteger(minor) || minor > MAX_MINOR) throw new RangeError(`--${flag} '${text}' is too large.`);
  return sign === "-" ? -minor : minor;
}

/** `1500.00 BDT` for minor units (no grouping, so it stays copyable). */
export function formatMinor(minor: number, money: StoreMoney): string {
  const digits = String(Math.abs(minor)).padStart(money.decimals + 1, "0");
  const whole = digits.slice(0, digits.length - money.decimals);
  const fraction = money.decimals > 0 ? `.${digits.slice(digits.length - money.decimals)}` : "";
  return `${minor < 0 ? "-" : ""}${whole}${fraction} ${money.code}`;
}
