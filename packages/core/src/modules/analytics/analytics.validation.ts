// src/modules/analytics/analytics.validation.ts
import { z } from "zod";

export const analyticsScriptTypes = [
    "google_analytics",
    "google_tag_manager",
    "facebook_pixel",
    "tiktok_pixel",
    "cloudflare_web_analytics",
    "custom",
] as const;

export type AnalyticsScriptType = (typeof analyticsScriptTypes)[number];

export const analyticsScriptTypeSchema = z.enum(analyticsScriptTypes);

export const CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC =
    "https://static.cloudflareinsights.com/beacon.min.js";

const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PLACEHOLDER =
    "YOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN";

const ACTIVE_ANALYTICS_PLACEHOLDER_PATTERNS: Array<{
    pattern: RegExp;
    label: string;
}> = [
    { pattern: /\bG-X{4,}\b/i, label: "GA4 measurement ID" },
    { pattern: /\bGTM-X{4,}\b/i, label: "Google Tag Manager container ID" },
    { pattern: /\bPIXEL_ID\b/i, label: "pixel ID" },
    { pattern: /\bYOUR_[A-Z0-9_]*PIXEL[A-Z0-9_]*ID\b/i, label: "pixel ID" },
    {
        pattern: /\bYOUR_CLOUDFLARE_WEB_ANALYTICS_TOKEN\b/i,
        label: "Cloudflare Web Analytics token",
    },
];

export function isMainThreadOnlyAnalyticsType(type: string): boolean {
    return type === "cloudflare_web_analytics";
}

export function normalizeCloudflareWebAnalyticsConfig(config: string): string {
    const trimmedConfig = config.trim();
    if (/<script/i.test(trimmedConfig)) {
        const token = extractCloudflareWebAnalyticsToken(trimmedConfig);
        return token ? buildCloudflareWebAnalyticsScript(token) : trimmedConfig;
    }

    return buildCloudflareWebAnalyticsScript(trimmedConfig);
}

function isValidCloudflareWebAnalyticsConfig(config: string): boolean {
    const trimmedConfig = config.trim();
    if (!trimmedConfig) {
        return false;
    }

    if (/<script/i.test(trimmedConfig)) {
        const token = extractCloudflareWebAnalyticsToken(trimmedConfig);
        return token !== null && isValidCloudflareWebAnalyticsToken(token);
    }

    return isValidCloudflareWebAnalyticsToken(trimmedConfig);
}

function buildCloudflareWebAnalyticsScript(token: string): string {
    return `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='${JSON.stringify({ token })}'></script>`;
}

function extractCloudflareWebAnalyticsToken(config: string): string | null {
    if (!config.includes(CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC)) {
        return null;
    }

    const beaconMatch = config.match(
        /data-cf-beacon\s*=\s*(["'])(.*?)\1/is,
    );
    if (!beaconMatch?.[2]) {
        return null;
    }

    try {
        const beaconConfig = JSON.parse(beaconMatch[2]) as { token?: unknown };
        return typeof beaconConfig.token === "string" ? beaconConfig.token : null;
    } catch {
        return null;
    }
}

function isValidCloudflareWebAnalyticsToken(token: string): boolean {
    return (
        token !== CLOUDFLARE_WEB_ANALYTICS_TOKEN_PLACEHOLDER &&
        CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN.test(token)
    );
}

const analyticsFields = {
    name: z.string().min(3).max(100),
    type: analyticsScriptTypeSchema,
    config: z.string().min(1),
    location: z.enum(["head", "body_start", "body_end"]),
};

type AnalyticsConfigInput = {
    type: AnalyticsScriptType;
    config: string;
    isActive?: boolean;
};

export function getActiveAnalyticsPlaceholderConfigError(
    data: Pick<AnalyticsConfigInput, "config" | "isActive">,
): string | null {
    if (data.isActive !== true) {
        return null;
    }

    const matchedPlaceholder = ACTIVE_ANALYTICS_PLACEHOLDER_PATTERNS.find(
        ({ pattern }) => pattern.test(data.config),
    );
    if (!matchedPlaceholder) {
        return null;
    }

    return `Replace the placeholder ${matchedPlaceholder.label} before activating this analytics script.`;
}

export function isPubliclyInjectableAnalyticsConfig(
    data: Pick<AnalyticsConfigInput, "config" | "isActive">,
): boolean {
    return getActiveAnalyticsPlaceholderConfigError(data) === null;
}

function validateAnalyticsConfig(
    data: AnalyticsConfigInput,
    ctx: z.RefinementCtx,
) {
    const placeholderError = getActiveAnalyticsPlaceholderConfigError(data);
    if (placeholderError) {
        ctx.addIssue({
            code: "custom",
            path: ["config"],
            message: placeholderError,
        });
    }

    if (
        data.type === "cloudflare_web_analytics" &&
        !isValidCloudflareWebAnalyticsConfig(data.config)
    ) {
        ctx.addIssue({
            code: "custom",
            path: ["config"],
            message:
                "Cloudflare Web Analytics config must be a site token or the official beacon script.",
        });
    }
}

export const createAnalyticsSchema = z.object({
    ...analyticsFields,
    isActive: z.boolean().default(true),
    usePartytown: z.boolean().default(true),
}).superRefine(validateAnalyticsConfig);

export const updateAnalyticsSchema = z.object({
    id: z.string(),
    ...analyticsFields,
    isActive: z.boolean(),
    usePartytown: z.boolean(),
}).superRefine(validateAnalyticsConfig);

export const toggleAnalyticsSchema = z.object({
    isActive: z.boolean(),
});
