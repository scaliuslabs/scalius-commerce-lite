// src/modules/navigation/navigation.validation.ts
// Zod schemas for navigation config validation.
// WIRE: api-app should import saveNavigationConfigSchema (or headerConfigSchema/footerConfigSchema)
// in routes/admin/navigation.ts to replace the inline `z.record(z.string(), z.unknown())` at line 120.
// Replace the local saveConfigSchema with: `import { saveNavigationConfigSchema } from "@scalius/core/modules/navigation";`
// and delete the local `navigationItemSchema` + `NavigationItem` type (lines 101-115).

import { z } from "zod";

/** Recursive schema for a navigation item (supports nested subMenus) */
export const navigationItemSchema: z.ZodType<{
    id: string;
    title: string;
    href?: string;
    subMenu?: unknown[];
}> = z.lazy(() =>
    z.object({
        id: z.string(),
        title: z.string(),
        href: z.string().optional(),
        subMenu: z.array(navigationItemSchema).optional(),
    })
);

const logoSchema = z.object({
    src: z.string(),
    alt: z.string(),
}).passthrough();

const socialLinkSchema = z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
}).passthrough();

/** Header config schema matching the admin HeaderConfig type */
export const headerConfigSchema = z.object({
    topBar: z.object({
        text: z.string(),
        isEnabled: z.boolean(),
    }).optional(),
    logo: logoSchema.optional(),
    favicon: z.object({
        src: z.string(),
        alt: z.string(),
    }).optional(),
    contact: z.object({
        phone: z.string(),
        text: z.string(),
        isEnabled: z.boolean(),
    }).optional(),
    social: z.array(socialLinkSchema).optional(),
    navigation: z.array(navigationItemSchema).optional(),
}).passthrough();

/** Footer menu column schema */
const footerMenuSchema = z.object({
    id: z.string(),
    title: z.string(),
    links: z.array(navigationItemSchema),
}).passthrough();

/** Footer config schema matching the admin FooterConfig type */
export const footerConfigSchema = z.object({
    logo: logoSchema.optional(),
    tagline: z.string().optional(),
    description: z.string().optional(),
    copyrightText: z.string().optional(),
    menus: z.array(footerMenuSchema).optional(),
    social: z.array(socialLinkSchema).optional(),
}).passthrough();

/** Schema for saving navigation config (header or footer) */
export const saveNavigationConfigSchema = z.object({
    type: z.enum(["header", "footer"]),
    config: z.union([headerConfigSchema, footerConfigSchema]),
});

export type SaveNavigationConfigInput = z.infer<typeof saveNavigationConfigSchema>;
