// Account → Profile: the posted name and address forms, read and checked the
// same way checkout checks an address. Pure, so the page (a plain POST that
// works without JavaScript) and its tests share it. Nothing here reaches a URL
// except an outcome flag.
import { getShippingAddressError } from "@/lib/checkout/shipping-address";
import { ENGLISH_CHECKOUT_LANGUAGE_DATA as copy } from "@scalius/shared/checkout-language";

export type ProfileIntent = "name" | "address" | "remove-address";
export type ProfileSavedFlag = "name" | "address" | "removed";

export interface AddressDraft {
  address: string;
  city: string;
  zone: string;
  area: string;
}

export interface ProfileForm {
  intent: ProfileIntent | null;
  name: string;
  draft: AddressDraft;
}

type Location = { id: string; name: string };

const INTENTS: readonly ProfileIntent[] = ["name", "address", "remove-address"];
const MAX_FIELD = 500;

function field(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.slice(0, MAX_FIELD).trim() : "";
}

export function readProfileForm(form: FormData): ProfileForm {
  const intent = form.get("intent");
  return {
    intent: INTENTS.includes(intent as ProfileIntent) ? intent as ProfileIntent : null,
    name: field(form, "name"),
    draft: { address: field(form, "address"), city: field(form, "city"), zone: field(form, "zone"), area: field(form, "area") },
  };
}

export function nameError(name: string): string | null {
  return name.trim() ? null : "Enter your full name.";
}

/**
 * Field errors for an address, against the store's live locations: the
 * thana must belong to the city and the (optional) area to the thana. A
 * browser without JavaScript that changed the city gets "choose a thana"
 * with the new city's thanas, which is how its two-step form works.
 */
export function addressErrors(
  draft: AddressDraft,
  locations: { cities: readonly Location[]; zones: readonly Location[]; areas: readonly Location[] },
): Partial<Record<keyof AddressDraft, string>> {
  const errors: Partial<Record<keyof AddressDraft, string>> = {};
  const address = getShippingAddressError(draft.address);
  if (address) errors.address = address;
  if (!draft.city || !locations.cities.some((city) => city.id === draft.city)) errors.city = "Choose a city.";
  else if (!draft.zone || !locations.zones.some((zone) => zone.id === draft.zone)) errors.zone = copy.zoneRequiredText;
  else if (draft.area && !locations.areas.some((area) => area.id === draft.area)) errors.area = "Choose an area in this thana, or leave it empty.";
  return errors;
}

const SAVED_TEXT: Record<ProfileSavedFlag, string> = {
  name: "Name saved.",
  address: "Address saved.",
  removed: "Address removed.",
};

export function readProfileSavedFlag(search: URLSearchParams): ProfileSavedFlag | null {
  const flag = search.get("saved");
  return flag && flag in SAVED_TEXT ? flag as ProfileSavedFlag : null;
}

export function profileSavedText(flag: ProfileSavedFlag): string {
  return SAVED_TEXT[flag];
}
