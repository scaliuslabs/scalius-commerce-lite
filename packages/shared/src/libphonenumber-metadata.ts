// The libphonenumber-js functions the server reads through "#libphonenumber"
// (package.json "imports"), bound to metadata the caller supplies: exactly
// what `libphonenumber-js/max` does with its bundled metadata, which appends
// the metadata to each call's own arguments. The API Worker loads the `max`
// metadata from a Text module on first use (apps/api/src/text-data/
// libphonenumber-max.ts) instead of compiling its 150 KiB literal at every
// isolate start.
import {
  getCountries as coreGetCountries,
  getCountryCallingCode as coreGetCountryCallingCode,
  isSupportedCountry as coreIsSupportedCountry,
  isValidPhoneNumber as coreIsValidPhoneNumber,
  parsePhoneNumberFromString as coreParsePhoneNumberFromString,
  parsePhoneNumberWithError as coreParsePhoneNumberWithError,
  type MetadataJson,
} from "libphonenumber-js/core";
import type * as Max from "libphonenumber-js/max";

export interface LibphonenumberFunctions {
  getCountries: typeof Max.getCountries;
  getCountryCallingCode: typeof Max.getCountryCallingCode;
  isSupportedCountry: typeof Max.isSupportedCountry;
  isValidPhoneNumber: typeof Max.isValidPhoneNumber;
  /** Throws on an unparseable number, as `libphonenumber-js/max` names it. */
  parsePhoneNumber: typeof Max.parsePhoneNumber;
  parsePhoneNumberFromString: typeof Max.parsePhoneNumberFromString;
}

/** The functions, reading the metadata `load()` returns on the first call. */
export function bindLibphonenumber(load: () => MetadataJson): LibphonenumberFunctions {
  let metadata: MetadataJson | undefined;
  const bind = (fn: (...args: never[]) => unknown) =>
    (...args: unknown[]) => (fn as (...args: unknown[]) => unknown)(...args, (metadata ??= load()));
  return {
    getCountries: bind(coreGetCountries) as typeof Max.getCountries,
    getCountryCallingCode: bind(coreGetCountryCallingCode) as typeof Max.getCountryCallingCode,
    isSupportedCountry: bind(coreIsSupportedCountry) as typeof Max.isSupportedCountry,
    isValidPhoneNumber: bind(coreIsValidPhoneNumber) as typeof Max.isValidPhoneNumber,
    parsePhoneNumber: bind(coreParsePhoneNumberWithError) as typeof Max.parsePhoneNumber,
    parsePhoneNumberFromString: bind(coreParsePhoneNumberFromString) as typeof Max.parsePhoneNumberFromString,
  };
}
