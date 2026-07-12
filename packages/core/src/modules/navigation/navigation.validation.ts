// src/modules/navigation/navigation.validation.ts
// Zod schemas for navigation config validation.
// WIRE: api-app should import saveNavigationConfigSchema (or headerConfigSchema/footerConfigSchema)
// in routes/admin/navigation.ts to replace the inline `z.record(z.string(), z.unknown())` at line 120.
// Replace the local saveConfigSchema with: `import { saveNavigationConfigSchema } from "@scalius/core/modules/navigation";`
// and delete the local `navigationItemSchema` + `NavigationItem` type (lines 101-115).

import { z } from "zod";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import { ValidationError } from "@scalius/core/errors";

export const MAX_NAVIGATION_DEPTH = 3;
export const MAX_NAVIGATION_ITEMS = 150;
export const MAX_FOOTER_MENUS = 4;
export const MAX_SOCIAL_LINKS = 8;

const stableIdSchema = z.string().trim().min(1).max(100);
const navigationLabelSchema = z.string().trim().min(1).max(80);

const httpsUrlSchema = z.string().trim().max(2_048).transform((value, context) => {
    try {
        const url = new URL(value);
        if (url.protocol !== "https:" || url.username || url.password) {
            throw new Error("invalid");
        }
        return url.toString();
    } catch {
        context.addIssue({
            code: "custom",
            message: "Use a credential-free HTTPS URL.",
        });
        return z.NEVER;
    }
});

const navigationHrefSchema = z.string().optional().transform((value, context) => {
    const result = parseNavigationHref(value);
    if (!result.ok) {
        context.addIssue({ code: "custom", message: result.reason });
        return z.NEVER;
    }
    return result.href;
});

/** Recursive schema for a navigation item (supports nested subMenus) */
export const navigationItemSchema: z.ZodType<{
    id: string;
    title: string;
    href?: string;
    subMenu?: unknown[];
}> = z.lazy(() =>
    z.object({
        id: stableIdSchema,
        title: navigationLabelSchema,
        href: navigationHrefSchema,
        subMenu: z.array(navigationItemSchema).optional(),
    })
);

const logoSchema = z.object({
    src: z.string(),
    alt: z.string(),
}).passthrough();

const socialLinkSchema = z.object({
    id: stableIdSchema,
    label: z.string().trim().min(1).max(40),
    url: httpsUrlSchema,
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
    social: z.array(socialLinkSchema).max(MAX_SOCIAL_LINKS).optional(),
    navigation: z.array(navigationItemSchema).optional(),
}).passthrough();

/** Footer menu column schema */
const footerMenuSchema = z.object({
    id: stableIdSchema,
    title: z.string().trim().min(1).max(60),
    links: z.array(navigationItemSchema),
}).passthrough();

/** Footer config schema matching the admin FooterConfig type */
export const footerConfigSchema = z.object({
    logo: logoSchema.optional(),
    tagline: z.string().optional(),
    description: z.string().optional(),
    copyrightText: z.string().optional(),
    menus: z.array(footerMenuSchema).max(MAX_FOOTER_MENUS).optional(),
    social: z.array(socialLinkSchema).max(MAX_SOCIAL_LINKS).optional(),
}).passthrough();

/** Schema for saving navigation config (header or footer) */
export const saveNavigationConfigSchema = z.object({
    type: z.enum(["header", "footer"]),
    config: z.union([headerConfigSchema, footerConfigSchema]),
});

export function parseNavigationConfig(
    type: "header" | "footer",
    config: unknown,
): Record<string, unknown> {
    const result = (type === "header" ? headerConfigSchema : footerConfigSchema)
        .safeParse(config);
    if (!result.success) {
        throw new ValidationError(
            result.error.issues[0]?.message ?? "Invalid navigation configuration.",
            result.error.issues,
        );
    }
    const parsed = result.data as Record<string, unknown>;
    const seenIds = new Set<string>();
    let itemCount = 0;

    const inspectItems = (items: unknown, depth: number): void => {
        if (!Array.isArray(items)) return;
        if (depth > MAX_NAVIGATION_DEPTH) {
            throw new ValidationError(
                `Navigation supports at most ${MAX_NAVIGATION_DEPTH} levels.`,
            );
        }
        for (const value of items) {
            const item = value as { id: string; subMenu?: unknown[] };
            itemCount += 1;
            if (itemCount > MAX_NAVIGATION_ITEMS) {
                throw new ValidationError(
                    `Navigation supports at most ${MAX_NAVIGATION_ITEMS} items.`,
                );
            }
            if (seenIds.has(item.id)) {
                throw new ValidationError("Navigation item IDs must be unique.");
            }
            seenIds.add(item.id);
            inspectItems(item.subMenu, depth + 1);
        }
    };

    if (type === "header") {
        inspectItems(parsed.navigation, 1);
    } else {
        const menuIds = new Set<string>();
        const menus = Array.isArray(parsed.menus) ? parsed.menus : [];
        for (const value of menus) {
            const menu = value as { id: string; links?: unknown[] };
            if (menuIds.has(menu.id)) {
                throw new ValidationError("Footer menu IDs must be unique.");
            }
            menuIds.add(menu.id);
            inspectItems(menu.links, 1);
        }
    }

    return parsed;
}

export type SaveNavigationConfigInput = z.infer<typeof saveNavigationConfigSchema>;
