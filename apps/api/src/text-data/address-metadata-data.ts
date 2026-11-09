// The API Worker's "#address-metadata-data" (apps/api/wrangler.jsonc `alias`):
// the libaddressinput table of packages/shared/src/address-metadata.data.ts,
// parsed from a Text module (../generated/address-metadata.gen.txt,
// `pnpm regen`) when the table is first read, instead of a literal compiled
// at every isolate start. text-data.test.ts proves the copy equals the source.
import type {
  ADDRESS_METADATA_DEFAULTS as SourceDefaults,
  ADDRESS_METADATA_SOURCE as SourceSource,
  CountryAddressMetadata,
} from "@scalius/shared/address-metadata.data";
// A Text module: a string, not compiled at isolate start.
import table from "../generated/address-metadata.gen.txt";

export type { CountryAddressMetadata } from "@scalius/shared/address-metadata.data";

const parsed = JSON.parse(table) as {
  source: typeof SourceSource;
  defaults: typeof SourceDefaults;
  metadata: Readonly<Record<string, CountryAddressMetadata>>;
};

export const ADDRESS_METADATA_SOURCE = parsed.source;
export const ADDRESS_METADATA_DEFAULTS = parsed.defaults;
export const ADDRESS_METADATA = parsed.metadata;
