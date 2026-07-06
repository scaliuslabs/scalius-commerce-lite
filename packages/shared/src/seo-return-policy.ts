export const SEO_RETURN_POLICY_CATEGORIES = [
  "finite",
  "unlimited",
  "no_returns",
] as const;
export const SEO_RETURN_POLICY_FEES = [
  "free",
  "customer_responsibility",
] as const;
export const SEO_RETURN_POLICY_METHODS = ["mail", "in_store", "both"] as const;

export type SeoReturnPolicyCategory =
  (typeof SEO_RETURN_POLICY_CATEGORIES)[number];
export type SeoReturnPolicyFees = (typeof SEO_RETURN_POLICY_FEES)[number];
export type SeoReturnPolicyMethod = (typeof SEO_RETURN_POLICY_METHODS)[number];

export interface SeoReturnPolicySettings {
  enabled: boolean;
  country: string;
  category: SeoReturnPolicyCategory;
  returnWindowDays: number | null;
  returnFees: SeoReturnPolicyFees;
  returnMethod: SeoReturnPolicyMethod;
  policyUrl: string;
}

export const DEFAULT_SEO_RETURN_POLICY_SETTINGS: SeoReturnPolicySettings = {
  enabled: false,
  country: "BD",
  category: "finite",
  returnWindowDays: null,
  returnFees: "customer_responsibility",
  returnMethod: "mail",
  policyUrl: "",
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function enumOrDefault<T extends readonly string[]>(
  value: unknown,
  options: T,
  fallback: T[number],
): T[number] {
  return typeof value === "string" && options.includes(value)
    ? value
    : fallback;
}

function countryOrDefault(value: unknown, fallback: string): string {
  const country = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{2}$/.test(country) ? country : fallback;
}

function returnWindowOrDefault(
  value: unknown,
  fallback: number | null,
): number | null {
  if (value === null) return null;
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;

  return Number.isInteger(numericValue) &&
    numericValue >= 1 &&
    numericValue <= 365
    ? numericValue
    : fallback;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function isValidSeoReturnPolicyUrl(value: string): boolean {
  const raw = value.trim();
  if (!raw) return true;
  if (
    raw.startsWith("/") &&
    !raw.startsWith("//") &&
    !raw.includes("\\") &&
    !hasControlCharacter(raw)
  ) {
    return true;
  }

  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function policyUrlOrDefault(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const url = value.trim();
  if (!url) return "";
  return isValidSeoReturnPolicyUrl(url) ? url : fallback;
}

export function normalizeSeoReturnPolicySettings(
  value: unknown,
): SeoReturnPolicySettings {
  const root = asRecord(value);
  const fallback = DEFAULT_SEO_RETURN_POLICY_SETTINGS;
  const category = enumOrDefault(
    root.category,
    SEO_RETURN_POLICY_CATEGORIES,
    fallback.category,
  );
  const returnWindowDays =
    category === "finite"
      ? returnWindowOrDefault(root.returnWindowDays, fallback.returnWindowDays)
      : null;
  const enabled = boolOrDefault(root.enabled, fallback.enabled);

  return {
    enabled: enabled && (category !== "finite" || returnWindowDays !== null),
    country: countryOrDefault(root.country, fallback.country),
    category,
    returnWindowDays,
    returnFees: enumOrDefault(
      root.returnFees,
      SEO_RETURN_POLICY_FEES,
      fallback.returnFees,
    ),
    returnMethod: enumOrDefault(
      root.returnMethod,
      SEO_RETURN_POLICY_METHODS,
      fallback.returnMethod,
    ),
    policyUrl: policyUrlOrDefault(root.policyUrl, fallback.policyUrl),
  };
}

export function mergeSeoReturnPolicySettings(
  base: unknown,
  patch: unknown,
): SeoReturnPolicySettings {
  return normalizeSeoReturnPolicySettings({
    ...normalizeSeoReturnPolicySettings(base),
    ...asRecord(patch),
  });
}

export function parseSeoReturnPolicySettings(
  value: string | null | undefined,
): SeoReturnPolicySettings {
  if (!value) return DEFAULT_SEO_RETURN_POLICY_SETTINGS;

  try {
    return normalizeSeoReturnPolicySettings(JSON.parse(value));
  } catch {
    return DEFAULT_SEO_RETURN_POLICY_SETTINGS;
  }
}
