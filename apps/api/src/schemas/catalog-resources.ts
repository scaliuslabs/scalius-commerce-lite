// Brand and content page resources: the one shape each is read in, by its
// get, its stable cursor list (routes/admin/resources-catalog-content.ts) and
// every write that answers it (`{ brand }`, `{ page }`).
import { z } from "@hono/zod-openapi";
import { brandStatusSchema } from "@scalius/core/modules/brands/browser";
import { nullableIsoTimestampSchema } from "./timestamps";
import { pageSchema } from "./entities";

const brandLogoSchema = z.object({
  mediaId: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

/** A brand as the dashboard's brand list shows it. */
export const brandRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: brandStatusSchema,
  sortOrder: z.number().int(),
  revision: z.number().int().min(1),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  productCount: z.number().int().min(0),
  logo: brandLogoSchema.nullable(),
  createdAt: nullableIsoTimestampSchema,
  updatedAt: nullableIsoTimestampSchema,
  deletedAt: nullableIsoTimestampSchema,
});

/** A brand as `brands.get` and `brands.list` read it and every brand write answers it (`{ brand }`). */
export const BrandResource = brandRowSchema.extend({
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  listingTemplate: z.string().nullable(),
  logoMediaId: z.string().nullable(),
}).openapi("BrandResource");

/** A page as `pages.get` and `pages.list` read it; create and update answer it too (`{ page }`). */
export const PageResource = pageSchema.openapi("PageResource");
