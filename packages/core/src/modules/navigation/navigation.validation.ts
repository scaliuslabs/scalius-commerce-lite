// src/modules/navigation/navigation.validation.ts
// Zod schemas for navigation config validation.
// WIRE: api-app should import saveNavigationConfigSchema (or headerConfigSchema/footerConfigSchema)
// in routes/admin/navigation.ts to replace the inline `z.record(z.string(), z.unknown())` at line 120.
// Replace the local saveConfigSchema with: `import { saveNavigationConfigSchema } from "@scalius/core/modules/navigation";`
// and delete the local `navigationItemSchema` + `NavigationItem` type (lines 101-115).

import { z } from "zod";
import { parseNavigationHref } from "@scalius/shared/navigation-href";
import {
    NAVIGATION_RESOURCE_TYPES,
    parseNavigationQuery,
    type NavigationTargetItem,
} from "@scalius/shared/navigation-target";
import { ValidationError } from "@scalius/core/errors";
import {
    HEADER_LOGO_WIDTH_MAX,
    HEADER_LOGO_WIDTH_MIN,
    HEADER_LOGO_WIDTH_STEP,
} from "@scalius/shared/brand-presentation";

export const MAX_NAVIGATION_DEPTH = 3;
export const MAX_NAVIGATION_ITEMS = 150;
export const MAX_FOOTER_MENUS = 4;
export const MAX_SOCIAL_LINKS = 8;

const stableIdSchema = z.string().trim().min(1).max(100);
const navigationLabelSchema = z.string().trim().min(1).max(80);

interface LegacyNavigationItem {
    id: string;
    title: string;
    href?: string;
    subMenu?: LegacyNavigationItem[];
}

const legacyNavigationItemSchema: z.ZodType<LegacyNavigationItem> = z.lazy(() =>
    z.object({
        id: stableIdSchema,
        title: navigationLabelSchema,
        href: z.string().optional(),
        subMenu: z.array(legacyNavigationItemSchema).optional(),
    }).strict()
);

const legacyFooterMenuSchema = z.object({
    id: stableIdSchema,
    title: z.string().trim().min(1).max(60),
    links: z.array(legacyNavigationItemSchema),
}).passthrough();

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

const resourceQuerySchema = z.string().optional().transform((value, context) => {
    const result = parseNavigationQuery(value);
    if (!result.ok) {
        context.addIssue({ code: "custom", message: result.reason });
        return z.NEVER;
    }
    return result.query;
});

const internalPathSchema = z.string().transform((value, context) => {
    const result = parseNavigationHref(value);
    if (!result.ok) {
        context.addIssue({ code: "custom", message: result.reason });
        return z.NEVER;
    }
    if (result.kind !== "internal" || !result.href) {
        context.addIssue({
            code: "custom",
            message: "Use a same-store path for an internal navigation target.",
        });
        return z.NEVER;
    }
    return result.href;
});

const externalUrlTargetSchema = z.string().transform((value, context) => {
    const result = parseNavigationHref(value);
    if (!result.ok) {
        context.addIssue({ code: "custom", message: result.reason });
        return z.NEVER;
    }
    if (result.kind !== "external" || !result.href) {
        context.addIssue({
            code: "custom",
            message: "Use a credential-free HTTPS URL for an external navigation target.",
        });
        return z.NEVER;
    }
    return result.href;
});

export const navigationTargetSchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("resource"),
        resourceType: z.enum(NAVIGATION_RESOURCE_TYPES),
        resourceId: stableIdSchema,
        query: resourceQuerySchema,
    }).strict(),
    z.object({
        type: z.literal("internal_path"),
        path: internalPathSchema,
    }).strict(),
    z.object({
        type: z.literal("external_url"),
        url: externalUrlTargetSchema,
    }).strict(),
    z.object({ type: z.literal("label") }).strict(),
]);

/** Recursive schema for a navigation item (supports nested subMenus) */
export const navigationItemSchema: z.ZodType<NavigationTargetItem> = z.lazy(() =>
    z.object({
        id: stableIdSchema,
        target: navigationTargetSchema,
        labelMode: z.enum(["resource", "custom"]),
        customLabel: navigationLabelSchema.optional(),
        lastKnownLabel: navigationLabelSchema.optional(),
        subMenu: z.array(navigationItemSchema).optional(),
        // Admin reads include this derived preview. It is accepted only so the
        // same document can be saved, then deliberately removed before storage.
        resolution: z.unknown().optional(),
    })
        .strict()
        .superRefine((item, context) => {
            if (item.labelMode === "custom" && !item.customLabel) {
                context.addIssue({
                    code: "custom",
                    path: ["customLabel"],
                    message: "Custom-label navigation items require a label.",
                });
            }
            if (item.target.type !== "resource" && item.labelMode !== "custom") {
                context.addIssue({
                    code: "custom",
                    path: ["labelMode"],
                    message: "Only resource targets can follow a resource label.",
                });
            }
        })
        .transform(({ resolution: _resolution, ...item }) => item)
);

const logoSchema = z.object({
    src: z.string(),
    alt: z.string(),
    width: z.number().int()
        .min(HEADER_LOGO_WIDTH_MIN)
        .max(HEADER_LOGO_WIDTH_MAX)
        .multipleOf(HEADER_LOGO_WIDTH_STEP)
        .optional(),
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

function normalizeLegacyNavigationItem(
    item: LegacyNavigationItem,
): NavigationTargetItem {
    const parsedHref = parseNavigationHref(item.href);
    if (!parsedHref.ok) {
        throw new ValidationError(parsedHref.reason);
    }

    const target: NavigationTargetItem["target"] = parsedHref.kind === "external"
        ? { type: "external_url", url: parsedHref.href ?? "" }
        : parsedHref.kind === "internal"
            ? { type: "internal_path", path: parsedHref.href ?? "" }
            : { type: "label" };

    return {
        id: item.id,
        target,
        labelMode: "custom",
        customLabel: item.title,
        ...(item.subMenu?.length
            ? { subMenu: item.subMenu.map(normalizeLegacyNavigationItem) }
            : {}),
    };
}

/**
 * Strict, explicit demo-data cutover from the former `{ title, href }` item
 * shape to typed targets. This helper never writes and deliberately rejects
 * mixed/dual-authority items; callers must persist its validated result through
 * an existing navigation save command.
 */
export function normalizeLegacyNavigationConfig(
    type: "header" | "footer",
    config: unknown,
): Record<string, unknown> {
    const configResult = z.record(z.string(), z.unknown()).safeParse(config);
    if (!configResult.success) {
        throw new ValidationError("Legacy navigation configuration must be an object.");
    }

    if (type === "header") {
        const navigationResult = z.array(legacyNavigationItemSchema)
            .safeParse(configResult.data.navigation);
        if (!navigationResult.success) {
            throw new ValidationError(
                "Legacy header navigation is not safe to normalize.",
                navigationResult.error.issues,
            );
        }
        return parseNavigationConfig("header", {
            ...configResult.data,
            navigation: navigationResult.data.map(normalizeLegacyNavigationItem),
        });
    }

    const menusResult = z.array(legacyFooterMenuSchema)
        .safeParse(configResult.data.menus);
    if (!menusResult.success) {
        throw new ValidationError(
            "Legacy footer navigation is not safe to normalize.",
            menusResult.error.issues,
        );
    }
    return parseNavigationConfig("footer", {
        ...configResult.data,
        menus: menusResult.data.map((menu) => ({
            ...menu,
            links: menu.links.map(normalizeLegacyNavigationItem),
        })),
    });
}

export type PersistedNavigationConfigState =
    | "ready"
    | "legacy_normalized"
    | "invalid";

export interface PersistedNavigationConfigRead {
    config: Record<string, unknown>;
    state: PersistedNavigationConfigState;
    message?: string;
}

/**
 * Read one persisted section without allowing its corruption to poison the
 * sibling section. Legacy conversion is in-memory only; explicit save commands
 * remain the sole write path for the typed result.
 */
export function readPersistedNavigationConfig(
    type: "header" | "footer",
    rawValue: string | null | undefined,
): PersistedNavigationConfigRead {
    if (!rawValue) return { config: {}, state: "ready" };

    let decoded: unknown;
    try {
        decoded = JSON.parse(rawValue);
    } catch {
        return {
            config: {},
            state: "invalid",
            message: `Stored ${type} configuration is invalid. Re-save this section in Settings.`,
        };
    }

    try {
        return { config: parseNavigationConfig(type, decoded), state: "ready" };
    } catch {
        // The typed authority failed. Only the exact former demo shape gets a
        // second, strict normalization attempt.
    }

    try {
        return {
            config: normalizeLegacyNavigationConfig(type, decoded),
            state: "legacy_normalized",
            message: `Legacy ${type} navigation was normalized in memory. Save this section to persist typed targets.`,
        };
    } catch {
        return {
            config: {},
            state: "invalid",
            message: `Stored ${type} configuration is invalid. Re-save this section in Settings.`,
        };
    }
}

export type SaveNavigationConfigInput = z.infer<typeof saveNavigationConfigSchema>;
