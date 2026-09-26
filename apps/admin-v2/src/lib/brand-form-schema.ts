/** The brand editor's form schema (its own module, so only the brand screens download it). */
import { z } from "zod";
import { BRAND_DESCRIPTION_MAX_LENGTH, BRAND_NAME_MAX_LENGTH, BRAND_STATUSES } from "@scalius/shared/catalog-brand";
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from "@scalius/shared/handle";
import { translate } from "~/i18n";
import { brandMessages } from "~/i18n/brands";
import { formMessages } from "~/i18n/forms";
import { canonicalPathFormSchema, mediaFileFormSchema, requireSavedAddress, says } from "./form-schemas";

const brandSays = (key: "nameRequired" | "nameTooLong") => ({ error: () => translate(brandMessages, key) });

/** Brand handles may be one character ("hp"); empty makes one from the name. */
const brandAddressSchema = z
  .string()
  .refine((value) => value === "" || (value.length <= HANDLE_MAX_LENGTH && HANDLE_PATTERN.test(value)), says("addressFormat"));

export const brandFormSchema = z
  .object({
    id: z.string().optional(),
    revision: z.number().int().min(1).optional(),
    status: z.enum(BRAND_STATUSES),
    name: z.string().trim().min(1, brandSays("nameRequired")).max(BRAND_NAME_MAX_LENGTH, brandSays("nameTooLong")),
    description: z.string().trim().max(BRAND_DESCRIPTION_MAX_LENGTH, says("textTooLong")).nullable(),
    slug: brandAddressSchema,
    logo: mediaFileFormSchema.nullable(),
    sortOrder: z.number().int().min(-100_000).max(100_000),
    metaTitle: z.string().trim().max(70, says("searchTitleTooLong")).nullable(),
    metaDescription: z.string().trim().max(200, says("searchDescriptionTooLong")).nullable(),
    canonicalPath: canonicalPathFormSchema("brand"),
    noIndex: z.boolean(),
    excludeFromSitemap: z.boolean(),
  })
  .superRefine((value, context) => {
    requireSavedAddress(value, context);
    if (value.canonicalPath !== null && value.canonicalPath !== `/brands/${value.slug}`) {
      context.addIssue({ code: "custom", path: ["canonicalPath"], message: translate(formMessages, "ownAddressOnly") });
    }
  });

export type BrandFormInput = z.input<typeof brandFormSchema>;
export type BrandFormValues = z.output<typeof brandFormSchema>;
