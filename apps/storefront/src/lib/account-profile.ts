// Account → Profile: the posted name and address-book forms, read and
// checked the same way checkout checks an address. Pure, so the page (a plain
// POST that works without JavaScript) and its tests share it. Nothing here
// reaches a URL except an outcome flag.
import { MIN_SHIPPING_ADDRESS_LENGTH } from "@/lib/checkout/shipping-address";
import {
  FOREIGN_ADDRESS_FIELDS,
  isLocationCountry,
  readForeignAddressFields,
  shippingCountryOf,
  type ForeignAddressField,
} from "@/lib/checkout/shipping-country";
import type { CustomerAddress } from "@/lib/api/customer-auth";
import { getCheckoutLanguagePreset } from "@scalius/shared/checkout-language";
import { accountCopy } from "@/lib/account-copy";
import { formatCount, pageLanguage } from "@/lib/store-time-zone";

export type ProfileIntent = "name" | "address" | "remove-address" | "default-address" | "default-billing-address";
export type ProfileSavedFlag = "name" | "address" | "removed" | "default" | "billing";

/** One address form: the address being edited (none: a new one) and its fields. */
export interface AddressDraft {
  addressId: string;
  countryCode: string;
  address: string;
  city: string;
  zone: string;
  area: string;
  shippingAddressLine2: string;
  shippingDependentLocality: string;
  shippingLocality: string;
  shippingAdminArea: string;
  shippingPostalCode: string;
  /** Make it the default (a new account's first address always is). */
  isDefault: boolean;
}

export type AddressDraftField = "address" | "city" | "zone" | "area" | ForeignAddressField;

export interface ProfileForm {
  intent: ProfileIntent | null;
  name: string;
  draft: AddressDraft;
}

type Location = { id: string; name: string };

const INTENTS: readonly ProfileIntent[] = ["name", "address", "remove-address", "default-address", "default-billing-address"];
const MAX_FIELD = 500;
const ADDRESS_ID = /^[A-Za-z0-9_-]{1,64}$/;

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.slice(0, MAX_FIELD).trim() : "";
}

/** An empty form in a country (Bangladesh unless the store sells only elsewhere). */
export function emptyAddressDraft(countryCode = "BD"): AddressDraft {
  return {
    addressId: "",
    countryCode,
    address: "",
    city: "",
    zone: "",
    area: "",
    shippingAddressLine2: "",
    shippingDependentLocality: "",
    shippingLocality: "",
    shippingAdminArea: "",
    shippingPostalCode: "",
    isDefault: false,
  };
}

/** A saved address as its edit form. */
export function addressDraftOf(address: CustomerAddress): AddressDraft {
  return {
    addressId: address.id,
    countryCode: address.countryCode,
    address: address.line1 ?? "",
    city: address.city ?? "",
    zone: address.zone ?? "",
    area: address.area ?? "",
    shippingAddressLine2: address.line2 ?? "",
    shippingDependentLocality: address.dependentLocality ?? "",
    shippingLocality: address.locality ?? "",
    shippingAdminArea: address.adminArea ?? "",
    shippingPostalCode: address.postalCode ?? "",
    isDefault: address.isDefault,
  };
}

export function readProfileForm(form: FormData): ProfileForm {
  const intent = form.get("intent");
  const addressId = field(form, "addressId");
  const foreign = readForeignAddressFields((name) => form.get(name));
  return {
    intent: INTENTS.includes(intent as ProfileIntent) ? intent as ProfileIntent : null,
    name: field(form, "name"),
    draft: {
      addressId: ADDRESS_ID.test(addressId) ? addressId : "",
      // Absent on a store that sells only to Bangladesh (no country field).
      countryCode: shippingCountryOf(form.get("shippingCountryCode")),
      address: field(form, "address"),
      city: field(form, "city"),
      zone: field(form, "zone"),
      area: field(form, "area"),
      ...Object.fromEntries(FOREIGN_ADDRESS_FIELDS.map((name) => [name, foreign[name] ?? ""])) as Record<ForeignAddressField, string>,
      isDefault: form.get("makeDefault") === "on",
    },
  };
}

export function nameError(name: string): string | null {
  return name.trim() ? null : accountCopy().profile.enterName;
}

/**
 * Field errors for an address. In Bangladesh, against the store's live
 * locations: the thana must belong to the city and the (optional) area to
 * the thana; a browser without JavaScript that changed the city gets "choose
 * a thana" with the new city's thanas, which is how its two-step form works.
 * Another country needs its first line here; the API checks the rest
 * against the country's rules.
 */
export function addressErrors(
  draft: Pick<AddressDraft, "address" | "city" | "zone" | "area"> & { countryCode?: string },
  locations: { cities: readonly Location[]; zones: readonly Location[]; areas: readonly Location[] },
): Partial<Record<AddressDraftField, string>> {
  // The page's language: the errors read where the buyer typed.
  const words = accountCopy().profile;
  const errors: Partial<Record<AddressDraftField, string>> = {};
  if (!isLocationCountry(draft.countryCode)) {
    if (!draft.address.trim()) errors.address = words.enterAddress;
    return errors;
  }
  const address = draft.address.trim();
  if (!address) errors.address = words.enterDeliveryAddress;
  else if (address.length < MIN_SHIPPING_ADDRESS_LENGTH) errors.address = words.completeAddress(formatCount(MIN_SHIPPING_ADDRESS_LENGTH));
  if (!draft.city || !locations.cities.some((city) => city.id === draft.city)) errors.city = words.chooseCity;
  else if (!draft.zone || !locations.zones.some((zone) => zone.id === draft.zone)) errors.zone = getCheckoutLanguagePreset(pageLanguage()).zoneRequiredText;
  else if (draft.area && !locations.areas.some((area) => area.id === draft.area)) errors.area = words.chooseArea;
  return errors;
}

const orNull = (value: string) => value.trim() || null;

/** What the address book API takes: Bangladesh sends its ids, another country its fields. */
export function addressBookInput(draft: AddressDraft) {
  const common = { line1: orNull(draft.address), ...(draft.isDefault ? { isDefault: true } : {}) };
  if (isLocationCountry(draft.countryCode)) {
    return { countryCode: "BD", ...common, city: orNull(draft.city), zone: orNull(draft.zone), area: orNull(draft.area) };
  }
  return {
    countryCode: draft.countryCode,
    ...common,
    line2: orNull(draft.shippingAddressLine2),
    dependentLocality: orNull(draft.shippingDependentLocality),
    locality: orNull(draft.shippingLocality),
    adminArea: orNull(draft.shippingAdminArea),
    postalCode: orNull(draft.shippingPostalCode),
  };
}

const SAVED_FLAGS: readonly ProfileSavedFlag[] = ["name", "address", "removed", "default", "billing"];

export function readProfileSavedFlag(search: URLSearchParams): ProfileSavedFlag | null {
  const flag = search.get("saved");
  return flag && (SAVED_FLAGS as readonly string[]).includes(flag) ? flag as ProfileSavedFlag : null;
}

export function profileSavedText(flag: ProfileSavedFlag): string {
  const words = accountCopy().profile;
  return {
    name: words.savedName,
    address: words.savedAddress,
    removed: words.removed,
    default: words.defaultChanged,
    billing: words.billingChanged,
  }[flag];
}
