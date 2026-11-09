// The API Worker's "#libphonenumber" (apps/api/wrangler.jsonc `alias`): the
// functions of `libphonenumber-js/max`, reading the same `max` metadata from a
// Text module (../generated/libphonenumber-max.gen.txt), parsed on the first
// call, instead of a 150 KiB literal compiled at every isolate start.
// text-data.test.ts proves the answers match `libphonenumber-js/max`.
import { bindLibphonenumber } from "@scalius/shared/libphonenumber-metadata";
// A Text module: a string, not compiled at isolate start.
import metadata from "../generated/libphonenumber-max.gen.txt";

export const {
  getCountries,
  getCountryCallingCode,
  isSupportedCountry,
  isValidPhoneNumber,
  parsePhoneNumber,
  parsePhoneNumberFromString,
} = bindLibphonenumber(() => JSON.parse(metadata));
