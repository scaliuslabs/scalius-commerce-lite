// src/modules/analytics/analytics.validation.ts
import { z } from "zod";

export const analyticsScriptTypes = [
    "google_analytics",
    "facebook_pixel",
    "cloudflare_web_analytics",
    "custom",
] as const;

export type AnalyticsScriptType = (typeof analyticsScriptTypes)[number];

export const analyticsScriptTypeSchema = z.enum(analyticsScriptTypes);

export const CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC =
    "https://static.cloudflareinsights.com/beacon.min.js";

const CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function isMainThreadOnlyAnalyticsType(type: string): boolean {
    return type === "cloudflare_web_analytics";
}

export function normalizeCloudflareWebAnalyticsConfig(config: string): string {
    const trimmedConfig = config.trim();
    if (/<script/i.test(trimmedConfig)) {
        return trimmedConfig;
    }

    return `<script defer src="${CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC}" data-cf-beacon='${JSON.stringify({ token: trimmedConfig })}'></script>`;
}

function isValidCloudflareWebAnalyticsConfig(config: string): boolean {
    const trimmedConfig = config.trim();
    if (!trimmedConfig) {
        return false;
    }

    if (/<script/i.test(trimmedConfig)) {
        return (
            trimmedConfig.includes(CLOUDFLARE_WEB_ANALYTICS_SCRIPT_SRC) &&
            /data-cf-beacon\s*=/.test(trimmedConfig)
        );
    }

    return CLOUDFLARE_WEB_ANALYTICS_TOKEN_PATTERN.test(trimmedConfig);
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
};

function validateAnalyticsConfig(
    data: AnalyticsConfigInput,
    ctx: z.RefinementCtx,
) {
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
