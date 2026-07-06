import type { ShippingMethod } from "@/lib/api/types";

export interface StorefrontBusinessInfo {
  companyName?: string | null;
  legalName?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  stateRegion?: string | null;
  postalCode?: string | null;
  country?: string | null;
  phone?: string | null;
  email?: string | null;
  taxId?: string | null;
}

export interface StorefrontSocialLink {
  url?: string | null;
}

export type StorefrontReturnPolicyCategory =
  | "finite"
  | "finite_window"
  | "finite_return_window"
  | "unlimited"
  | "unlimited_window"
  | "no_returns"
  | "no_return"
  | "not_permitted"
  | string
  | null
  | undefined;

export interface StorefrontReturnPolicySettings {
  enabled?: boolean | null;
  category?: StorefrontReturnPolicyCategory;
  returnPolicyCategory?: StorefrontReturnPolicyCategory;
  returnWindowDays?: number | string | null;
  merchantReturnDays?: number | string | null;
  returnFees?: string | null;
  returnMethod?: string | null;
  policyUrl?: string | null;
  merchantReturnLink?: string | null;
  country?: string | string[] | null;
  applicableCountry?: string | string[] | null;
  returnPolicyCountry?: string | string[] | null;
}

export interface MerchantReturnPolicyJsonLd {
  "@type": "MerchantReturnPolicy";
  applicableCountry?: string | string[];
  returnPolicyCountry?: string | string[];
  returnPolicyCategory?: string;
  merchantReturnDays?: number;
  merchantReturnLink?: string;
  returnFees?: string;
  returnMethod?: string | string[];
}

export type VariantBarcodeType = "ean13" | "upc" | "isbn" | "gtin" | "custom" | string | null | undefined;

const MERCHANT_RETURN_POLICY_CATEGORIES = {
  finite: "https://schema.org/MerchantReturnFiniteReturnWindow",
  noReturns: "https://schema.org/MerchantReturnNotPermitted",
  unlimited: "https://schema.org/MerchantReturnUnlimitedWindow",
} as const;

const MERCHANT_RETURN_FEES = {
  free: "https://schema.org/FreeReturn",
  customerResponsibility:
    "https://schema.org/ReturnFeesCustomerResponsibility",
} as const;

const MERCHANT_RETURN_METHODS = {
  mail: "https://schema.org/ReturnByMail",
  inStore: "https://schema.org/ReturnInStore",
} as const;

type NormalizedMerchantReturnPolicyCategory =
  keyof typeof MERCHANT_RETURN_POLICY_CATEGORIES;

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function toHttpUrl(value: string | null | undefined): string | null {
  const trimmed = cleanString(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function normalizeSchemaCountryCode(value: string | null | undefined): string {
  const normalized = cleanString(value)?.toLowerCase();
  if (!normalized) return "BD";
  if (normalized === "bd" || normalized === "bangladesh") return "BD";
  return cleanString(value) ?? "BD";
}

function normalizeReturnPolicyCountryCode(
  value: string | null | undefined,
): string | null {
  const trimmed = cleanString(value);
  if (!trimmed) return null;

  const normalized = normalizeSchemaCountryCode(trimmed).toUpperCase();
  return /^[A-Z]{2}$/.test(normalized) ? normalized : null;
}

function normalizeReturnPolicyCountries(
  value: string | string[] | null | undefined,
  fallback?: string | null,
): string | string[] | null {
  const candidates = Array.isArray(value) ? value : [value];
  const countries = new Set<string>();

  for (const candidate of candidates) {
    const country = normalizeReturnPolicyCountryCode(candidate);
    if (country) countries.add(country);
  }

  if (countries.size === 0) {
    const fallbackCountry = normalizeReturnPolicyCountryCode(fallback);
    if (fallbackCountry) countries.add(fallbackCountry);
  }

  const normalizedCountries = [...countries].slice(0, 50);
  if (normalizedCountries.length === 0) return null;
  return normalizedCountries.length === 1
    ? normalizedCountries[0]
    : normalizedCountries;
}

function normalizePositiveInteger(value: number | string | null | undefined): number | null {
  const normalizedValue =
    typeof value === "string" ? Number(cleanString(value)) : value;
  return Number.isInteger(normalizedValue) && Number(normalizedValue) > 0
    ? Number(normalizedValue)
    : null;
}

function normalizeMerchantReturnPolicyCategory(
  value: StorefrontReturnPolicyCategory,
): { key: NormalizedMerchantReturnPolicyCategory; url: string } | null {
  const normalized = cleanString(value)?.toLowerCase();
  if (!normalized) return null;

  const token = normalized
    .replace(/^https:\/\/schema\.org\//, "")
    .replace(/[\s-]+/g, "_");

  switch (token) {
    case "finite":
    case "finite_window":
    case "finite_return_window":
    case "limited":
    case "limited_window":
    case "merchantreturnfinitereturnwindow":
      return {
        key: "finite",
        url: MERCHANT_RETURN_POLICY_CATEGORIES.finite,
      };
    case "no_returns":
    case "no_return":
    case "not_permitted":
    case "not_allowed":
    case "none":
    case "merchantreturnnotpermitted":
      return {
        key: "noReturns",
        url: MERCHANT_RETURN_POLICY_CATEGORIES.noReturns,
      };
    case "unlimited":
    case "unlimited_window":
    case "unlimited_returns":
    case "merchantreturnunlimitedwindow":
      return {
        key: "unlimited",
        url: MERCHANT_RETURN_POLICY_CATEGORIES.unlimited,
      };
    default:
      return null;
  }
}

function normalizeMerchantReturnFees(value: string | null | undefined): string | null {
  const token = cleanString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  switch (token) {
    case "free":
    case "free_return":
    case "freereturn":
      return MERCHANT_RETURN_FEES.free;
    case "customer_responsibility":
    case "buyer_pays":
    case "returnfeescustomerresponsibility":
      return MERCHANT_RETURN_FEES.customerResponsibility;
    default:
      return null;
  }
}

function normalizeMerchantReturnMethod(
  value: string | null | undefined,
): string | string[] | null {
  const token = cleanString(value)?.toLowerCase().replace(/[\s-]+/g, "_");
  switch (token) {
    case "mail":
    case "return_by_mail":
    case "returnbymail":
      return MERCHANT_RETURN_METHODS.mail;
    case "in_store":
    case "store":
    case "return_in_store":
    case "returninstore":
      return MERCHANT_RETURN_METHODS.inStore;
    case "both":
    case "mail_and_in_store":
      return [MERCHANT_RETURN_METHODS.mail, MERCHANT_RETURN_METHODS.inStore];
    default:
      return null;
  }
}

function resolveMerchantReturnLink(
  value: string | null | undefined,
  storefrontUrl: string | null | undefined,
): string | null {
  const trimmed = cleanString(value);
  if (!trimmed) return null;

  const absoluteUrl = toHttpUrl(trimmed);
  if (absoluteUrl) return absoluteUrl;

  const baseUrl = toHttpUrl(storefrontUrl);
  if (!baseUrl) return null;
  if (trimmed.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return null;
  }

  try {
    const base = new URL(baseUrl);
    const parsed = new URL(trimmed, `${base.toString().replace(/\/$/, "")}/`);
    return parsed.origin === base.origin &&
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

function buildPostalAddress(business: StorefrontBusinessInfo | null | undefined) {
  if (!business) return null;

  const streetParts = [business.addressLine1, business.addressLine2]
    .map(cleanString)
    .filter((part): part is string => Boolean(part));
  const addressLocality = cleanString(business.city);
  const addressRegion = cleanString(business.stateRegion);
  const postalCode = cleanString(business.postalCode);
  const addressCountry = normalizeSchemaCountryCode(business.country);

  if (streetParts.length === 0 && !addressLocality && !addressRegion && !postalCode) {
    return null;
  }

  return {
    "@type": "PostalAddress",
    ...(streetParts.length > 0 ? { streetAddress: streetParts.join(", ") } : {}),
    ...(addressLocality ? { addressLocality } : {}),
    ...(addressRegion ? { addressRegion } : {}),
    ...(postalCode ? { postalCode } : {}),
    addressCountry,
  };
}

export function buildOnlineStoreJsonLd({
  storefrontUrl,
  logoUrl,
  storeName,
  business,
  social,
  returnPolicy,
}: {
  storefrontUrl: string | null;
  logoUrl: string | null;
  storeName: string;
  business?: StorefrontBusinessInfo | null;
  social?: StorefrontSocialLink[] | null;
  returnPolicy?: MerchantReturnPolicyJsonLd | null;
}) {
  if (!storefrontUrl || !logoUrl) return null;

  const companyName = cleanString(business?.companyName);
  const legalName = cleanString(business?.legalName);
  const telephone = cleanString(business?.phone);
  const email = cleanString(business?.email);
  const taxID = cleanString(business?.taxId);
  const address = buildPostalAddress(business);
  const sameAs = (social ?? [])
    .map((item) => toHttpUrl(item.url))
    .filter((url): url is string => Boolean(url));

  return {
    "@context": "https://schema.org",
    "@type": "OnlineStore",
    "@id": `${storefrontUrl}/#store`,
    name: companyName || legalName || storeName,
    url: storefrontUrl,
    logo: { "@type": "ImageObject", url: logoUrl },
    ...(legalName ? { legalName } : {}),
    ...(address ? { address } : {}),
    ...(telephone ? { telephone } : {}),
    ...(email ? { email } : {}),
    ...(taxID ? { taxID } : {}),
    ...(returnPolicy ? { hasMerchantReturnPolicy: returnPolicy } : {}),
    ...(telephone || email
      ? {
          contactPoint: {
            "@type": "ContactPoint",
            contactType: "customer service",
            ...(telephone ? { telephone } : {}),
            ...(email ? { email } : {}),
            areaServed: normalizeSchemaCountryCode(business?.country),
          },
        }
      : {}),
    ...(sameAs.length > 0 ? { sameAs } : {}),
  };
}

export function buildMerchantReturnPolicyJsonLd({
  settings,
  storefrontUrl,
  fallbackCountry,
}: {
  settings?: StorefrontReturnPolicySettings | null;
  storefrontUrl?: string | null;
  fallbackCountry?: string | null;
}): MerchantReturnPolicyJsonLd | null {
  if (!settings || settings.enabled !== true) return null;

  const merchantReturnLink = resolveMerchantReturnLink(
    settings.policyUrl ?? settings.merchantReturnLink,
    storefrontUrl,
  );
  const policy: MerchantReturnPolicyJsonLd = {
    "@type": "MerchantReturnPolicy",
    ...(merchantReturnLink ? { merchantReturnLink } : {}),
  };
  const category = normalizeMerchantReturnPolicyCategory(
    settings.category ?? settings.returnPolicyCategory,
  );
  if (!category) return merchantReturnLink ? policy : null;

  const applicableCountry = normalizeReturnPolicyCountries(
    settings.applicableCountry ?? settings.country,
    fallbackCountry,
  );
  if (!applicableCountry) return merchantReturnLink ? policy : null;

  if (category.key === "finite") {
    const merchantReturnDays = normalizePositiveInteger(
      settings.returnWindowDays ?? settings.merchantReturnDays,
    );
    if (!merchantReturnDays) return merchantReturnLink ? policy : null;
    policy.merchantReturnDays = merchantReturnDays;
  }

  policy.applicableCountry = applicableCountry;
  policy.returnPolicyCategory = category.url;

  if (category.key !== "noReturns") {
    const returnFees = normalizeMerchantReturnFees(settings.returnFees);
    const returnMethod = normalizeMerchantReturnMethod(settings.returnMethod);
    if (returnFees) policy.returnFees = returnFees;
    if (returnMethod) policy.returnMethod = returnMethod;
  }

  const returnPolicyCountry = normalizeReturnPolicyCountries(
    settings.returnPolicyCountry,
  );
  if (returnPolicyCountry) policy.returnPolicyCountry = returnPolicyCountry;

  return policy;
}

export function buildOfferShippingDetails({
  shippingMethods,
  currencyCode,
  freeDelivery,
  country,
}: {
  shippingMethods: ShippingMethod[] | null | undefined;
  currencyCode: string;
  freeDelivery: boolean;
  country?: string | null;
}) {
  const addressCountry = normalizeSchemaCountryCode(country);
  const details = (shippingMethods ?? [])
    .filter((method) => method.isActive !== false)
    .map((method) => {
      const fee = Number(method.fee);
      if (!Number.isFinite(fee) || fee < 0) return null;
      const value = freeDelivery ? 0 : fee;

      return {
        "@type": "OfferShippingDetails",
        ...(cleanString(method.name) ? { name: cleanString(method.name) } : {}),
        shippingDestination: {
          "@type": "DefinedRegion",
          addressCountry,
        },
        shippingRate: {
          "@type": "MonetaryAmount",
          value: value.toFixed(2),
          currency: currencyCode,
        },
      };
    })
    .filter((detail): detail is Exclude<typeof detail, null> => Boolean(detail));

  return details;
}

export function gtinPropertyForBarcodeType(type: VariantBarcodeType): string | null {
  switch (type) {
    case "ean13":
      return "gtin13";
    case "upc":
      return "gtin12";
    case "isbn":
      return "isbn";
    case "gtin":
      return "gtin";
    default:
      return null;
  }
}

export function gtinJsonLdForVariant(
  barcode: string | null | undefined,
  barcodeType: VariantBarcodeType,
): Record<string, string> {
  const value = cleanString(barcode);
  const property = gtinPropertyForBarcodeType(barcodeType);
  return value && property ? { [property]: value } : {};
}
