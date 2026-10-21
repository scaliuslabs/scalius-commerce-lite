// The one postal address shape of the stable app API (audit L3): the fields
// of the sealed representation's `PostalAddress` (`orders.get` shipping and
// billing addresses, `@scalius/shared/events`), with the store's delivery
// place ids only under `placeIds` (Bangladesh's City, Thana, Area; AGENTS.md
// address rules). Every stable input that takes an address takes this.
import { z } from "@hono/zod-openapi";

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

/** The store's delivery place ids, where its delivery zones use them. */
export const placeIdsInputSchema = z.object({
  city: z.string().trim().min(1).max(180).nullable().optional(),
  zone: z.string().trim().min(1).max(180).nullable().optional(),
  area: z.string().trim().min(1).max(180).nullable().optional(),
}).strict().openapi({ description: "The store's delivery place ids (Bangladesh's City, Thana, Area), where its delivery zones use them." });

/** The address lines: what a resource's own contact does not already carry. */
export const postalAddressLinesInputSchema = z.object({
  countryCode: z.string().trim().length(2).openapi({ description: "ISO 3166-1 alpha-2." }),
  company: optionalText(100),
  line1: z.string().trim().min(1).max(500),
  line2: optionalText(200),
  dependentLocality: optionalText(120),
  locality: optionalText(120),
  adminArea: optionalText(120),
  postalCode: optionalText(20),
  placeIds: placeIdsInputSchema.optional(),
}).strict();

/** A full postal address: the lines plus the recipient's name and phone. */
export const postalAddressInputSchema = postalAddressLinesInputSchema.extend({
  name: optionalText(100),
  phone: z.string().trim().max(32).nullable().optional(),
}).strict();

export type PostalAddressInput = z.output<typeof postalAddressInputSchema>;
