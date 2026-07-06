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

export type VariantBarcodeType = "ean13" | "upc" | "isbn" | "gtin" | "custom" | string | null | undefined;

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
}: {
  storefrontUrl: string | null;
  logoUrl: string | null;
  storeName: string;
  business?: StorefrontBusinessInfo | null;
  social?: StorefrontSocialLink[] | null;
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
