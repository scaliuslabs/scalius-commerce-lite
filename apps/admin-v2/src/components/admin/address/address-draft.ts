// The dashboard's address draft (MARKETS-DESIGN D7): what an address form
// holds, what it sends, and how the API's refusal maps back to its fields.
// Bangladesh keeps its City → Thana → Area ids; another country fills the
// canonical fields its rules use. The rules themselves come from the API.
import { normalizeAddressText, type AddressField, type AddressRules } from "@scalius/shared/address";
import { DELIVERY_HIERARCHY_COUNTRY } from "@scalius/shared/markets";
import { AdminApiResponseError } from "~/lib/admin-api-error";

export interface AddressDraft {
  countryCode: string;
  name: string;
  company: string;
  line1: string;
  line2: string;
  dependentLocality: string;
  locality: string;
  adminArea: string;
  postalCode: string;
  /** Bangladesh: the delivery locations (ids) and their names. */
  city: string | null;
  zone: string | null;
  area: string | null;
  cityName: string;
  zoneName: string;
  areaName: string;
}

/** A stored address: a customer address or an order snapshot read as one. */
export interface StoredAddress {
  countryCode?: string | null;
  name?: string | null;
  company?: string | null;
  line1?: string | null;
  line2?: string | null;
  dependentLocality?: string | null;
  locality?: string | null;
  adminArea?: string | null;
  postalCode?: string | null;
  city?: string | null;
  zone?: string | null;
  area?: string | null;
  cityName?: string | null;
  zoneName?: string | null;
  areaName?: string | null;
}

/** The order snapshot's fields (`shipping*` plus Bangladesh's ids and names). */
export interface OrderAddressFields {
  shippingCountryCode?: string | null;
  shippingAddress?: string | null;
  shippingAddressLine2?: string | null;
  shippingDependentLocality?: string | null;
  shippingLocality?: string | null;
  shippingAdminArea?: string | null;
  shippingPostalCode?: string | null;
  shippingCompany?: string | null;
  city?: string | null;
  zone?: string | null;
  area?: string | null;
  cityName?: string | null;
  zoneName?: string | null;
  areaName?: string | null;
}

export function usesLocationPicker(countryCode: string | null | undefined): boolean {
  return (countryCode || DELIVERY_HIERARCHY_COUNTRY) === DELIVERY_HIERARCHY_COUNTRY;
}

export function emptyAddressDraft(countryCode: string = DELIVERY_HIERARCHY_COUNTRY): AddressDraft {
  return {
    countryCode,
    name: "", company: "", line1: "", line2: "",
    dependentLocality: "", locality: "", adminArea: "", postalCode: "",
    city: null, zone: null, area: null, cityName: "", zoneName: "", areaName: "",
  };
}

export function addressDraftFrom(address: StoredAddress | null | undefined): AddressDraft {
  if (!address) return emptyAddressDraft();
  return {
    countryCode: address.countryCode || DELIVERY_HIERARCHY_COUNTRY,
    name: address.name ?? "",
    company: address.company ?? "",
    line1: address.line1 ?? "",
    line2: address.line2 ?? "",
    dependentLocality: address.dependentLocality ?? "",
    locality: address.locality ?? "",
    adminArea: address.adminArea ?? "",
    postalCode: address.postalCode ?? "",
    city: address.city ?? null,
    zone: address.zone ?? null,
    area: address.area ?? null,
    cityName: address.cityName ?? "",
    zoneName: address.zoneName ?? "",
    areaName: address.areaName ?? "",
  };
}

export function orderAddressDraft(order: OrderAddressFields): AddressDraft {
  return addressDraftFrom({
    countryCode: order.shippingCountryCode,
    company: order.shippingCompany,
    line1: order.shippingAddress,
    line2: order.shippingAddressLine2,
    dependentLocality: order.shippingDependentLocality,
    locality: order.shippingLocality,
    adminArea: order.shippingAdminArea,
    postalCode: order.shippingPostalCode,
    city: order.city,
    zone: order.zone,
    area: order.area,
    cityName: order.cityName,
    zoneName: order.zoneName,
    areaName: order.areaName,
  });
}

/** The address a draft becomes in another country: lines and names stay, region and ids go. */
export function draftInCountry(draft: AddressDraft, countryCode: string): AddressDraft {
  if (countryCode === draft.countryCode) return draft;
  return {
    ...draft,
    countryCode,
    adminArea: "",
    postalCode: "",
    dependentLocality: "",
    locality: "",
    city: null, zone: null, area: null, cityName: "", zoneName: "", areaName: "",
  };
}

const text = (value: string) => normalizeAddressText(value);

/** What the API takes (`addressInputSchema`): Bangladesh sends its ids; another country its canonical fields. */
export function addressDraftInput(draft: AddressDraft) {
  if (usesLocationPicker(draft.countryCode)) {
    return {
      countryCode: DELIVERY_HIERARCHY_COUNTRY,
      name: text(draft.name),
      company: text(draft.company),
      line1: text(draft.line1),
      city: draft.city || null,
      zone: draft.zone || null,
      area: draft.area || null,
    };
  }
  return {
    countryCode: draft.countryCode,
    name: text(draft.name),
    company: text(draft.company),
    line1: text(draft.line1),
    line2: text(draft.line2),
    dependentLocality: text(draft.dependentLocality),
    locality: text(draft.locality),
    adminArea: text(draft.adminArea),
    postalCode: text(draft.postalCode),
  };
}

/** The order write's address fields (`shipping*` plus Bangladesh's ids). */
export function orderAddressInput(draft: AddressDraft) {
  const input = addressDraftInput(draft);
  if (usesLocationPicker(draft.countryCode)) {
    return {
      shippingCountryCode: DELIVERY_HIERARCHY_COUNTRY,
      shippingAddress: input.line1,
      shippingCompany: input.company,
      city: draft.city || null,
      zone: draft.zone || null,
      area: draft.area || null,
    };
  }
  return {
    shippingCountryCode: draft.countryCode,
    shippingAddress: input.line1,
    shippingAddressLine2: text(draft.line2),
    shippingDependentLocality: text(draft.dependentLocality),
    shippingLocality: text(draft.locality),
    shippingAdminArea: text(draft.adminArea),
    shippingPostalCode: text(draft.postalCode),
    shippingCompany: input.company,
    city: null,
    zone: null,
    area: null,
  };
}

/** An order's billing snapshot (migration 0119). */
export interface OrderBillingFields {
  billingSameAsShipping?: boolean | null;
  billingCountryCode?: string | null;
  billingName?: string | null;
  billingCompany?: string | null;
  billingAddress?: string | null;
  billingAddressLine2?: string | null;
  billingDependentLocality?: string | null;
  billingLocality?: string | null;
  billingAdminArea?: string | null;
  billingPostalCode?: string | null;
}

/**
 * The billing editor's draft of an order: its billing snapshot, or (none
 * yet) an empty address in `fallbackCountry`. A billing address has no
 * City → Thana picker: Bangladesh fills its canonical fields.
 */
export function orderBillingDraft(order: OrderBillingFields, fallbackCountry: string = DELIVERY_HIERARCHY_COUNTRY): AddressDraft {
  if (!order.billingCountryCode) return emptyAddressDraft(fallbackCountry);
  return addressDraftFrom({
    countryCode: order.billingCountryCode,
    name: order.billingName,
    company: order.billingCompany,
    line1: order.billingAddress,
    line2: order.billingAddressLine2,
    dependentLocality: order.billingDependentLocality,
    locality: order.billingLocality,
    adminArea: order.billingAdminArea,
    postalCode: order.billingPostalCode,
  });
}

/**
 * The order write's billing fields: "same as shipping" (an order that ships),
 * a billing address, or none (an empty draft: the order has no billing address).
 */
export function orderBillingInput(draft: AddressDraft, sameAsShipping: boolean) {
  if (sameAsShipping) return { billingSameAsShipping: true, billingCountryCode: null };
  const empty = ![draft.name, draft.company, draft.line1, draft.line2, draft.dependentLocality, draft.locality, draft.adminArea, draft.postalCode]
    .some((value) => value.trim());
  if (empty && !draft.countryCode) return { billingSameAsShipping: false, billingCountryCode: null };
  return {
    billingSameAsShipping: false,
    billingCountryCode: draft.countryCode || null,
    billingName: text(draft.name),
    billingCompany: text(draft.company),
    billingAddress: text(draft.line1),
    billingAddressLine2: text(draft.line2),
    billingDependentLocality: text(draft.dependentLocality),
    billingLocality: text(draft.locality),
    billingAdminArea: text(draft.adminArea),
    billingPostalCode: text(draft.postalCode),
  };
}

/** The billing fields an address the API refused breaks (`billing_address_invalid`), or null. */
export function readBillingAddressProblems(error: unknown): AddressProblem[] | null {
  if (!(error instanceof AdminApiResponseError)) return null;
  const details = error.details as { reason?: unknown; issues?: unknown } | undefined;
  if (details?.reason !== "billing_address_invalid" || !Array.isArray(details.issues)) return null;
  return details.issues.filter((issue): issue is AddressProblem =>
    Boolean(issue) && typeof issue.field === "string" && typeof issue.code === "string");
}

export function isAddressDraftEmpty(draft: AddressDraft): boolean {
  return ![draft.line1, draft.line2, draft.locality, draft.adminArea, draft.postalCode, draft.dependentLocality, draft.company, draft.name]
    .some((value) => value.trim()) && !draft.city && !draft.zone;
}

export type AddressProblemField = AddressField | "countryCode" | "phone" | "city" | "zone" | "area";

export interface AddressProblem {
  field: AddressProblemField;
  code: "required" | "invalid" | "too_long" | "unknown_country" | "unavailable";
}

/** The fields an address the API refused breaks (`details.issues`), or null for another error. */
export function readAddressProblems(error: unknown): AddressProblem[] | null {
  if (!(error instanceof AdminApiResponseError)) return null;
  const details = error.details as { reason?: unknown; issues?: unknown } | undefined;
  if (details?.reason !== "address_invalid" || !Array.isArray(details.issues)) return null;
  return details.issues.filter((issue): issue is AddressProblem =>
    Boolean(issue) && typeof issue.field === "string" && typeof issue.code === "string");
}

/** A field's label key in `addressMessages` under a country's rules. */
export function addressFieldLabelKey(field: AddressField, rules: Pick<AddressRules, "labels"> | null) {
  switch (field) {
    case "locality":
      return `locality.${rules?.labels.locality ?? "city"}` as const;
    case "adminArea":
      return `adminArea.${rules?.labels.adminArea ?? "province"}` as const;
    case "dependentLocality":
      return `dependentLocality.${rules?.labels.dependentLocality ?? "suburb"}` as const;
    case "postalCode":
      return `postalCode.${rules?.labels.postalCode ?? "postal"}` as const;
    default:
      return field;
  }
}
