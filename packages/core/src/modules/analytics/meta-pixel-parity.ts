import { analytics } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { eq } from "drizzle-orm";

const META_PIXEL_ID_PATTERN = /^\d{5,30}$/;

export const metaPixelParityStatuses = [
    "not_configured",
    "invalid_capi_pixel_id",
    "no_browser_pixel",
    "unreadable_browser_pixel",
    "ok",
    "mismatch",
    "multiple_browser_pixels",
    "unavailable",
] as const;

export type MetaPixelParityStatus = (typeof metaPixelParityStatuses)[number];
export type MetaPixelParitySeverity = "neutral" | "success" | "warning";

export interface MetaPixelParityDiagnostics {
    status: MetaPixelParityStatus;
    severity: MetaPixelParitySeverity;
    message: string;
    capiPixelId: string | null;
    activeBrowserPixelIds: string[];
    activeFacebookPixelScriptCount: number;
    parseableFacebookPixelScriptCount: number;
}

export interface FacebookPixelScriptForParity {
    config: string | null;
    type?: string | null;
}

function normalizeMetaPixelId(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) {
        return null;
    }

    return META_PIXEL_ID_PATTERN.test(trimmed) ? trimmed : null;
}

function unique(values: string[]): string[] {
    return Array.from(new Set(values));
}

function looksLikeFacebookPixelCandidate(script: FacebookPixelScriptForParity): boolean {
    if (script.type === "facebook_pixel") {
        return true;
    }

    return extractFacebookPixelIdsFromScript(script.config).length > 0;
}

export function extractFacebookPixelIdsFromScript(config: string | null | undefined): string[] {
    if (!config) {
        return [];
    }

    const ids: string[] = [];
    const initPattern = /fbq\s*\(\s*["']init["']\s*,\s*["'](\d{5,30})["']/gi;

    for (const match of config.matchAll(initPattern)) {
        if (match[1]) {
            ids.push(match[1]);
        }
    }

    return unique(ids);
}

export function buildMetaPixelParityDiagnostics(
    capiPixelId: string | null | undefined,
    activeFacebookPixelScripts: FacebookPixelScriptForParity[],
): MetaPixelParityDiagnostics {
    const trimmedCapiPixelId = capiPixelId?.trim() || null;
    const normalizedCapiPixelId = normalizeMetaPixelId(capiPixelId);
    const pixelCandidateScripts = activeFacebookPixelScripts.filter(
        looksLikeFacebookPixelCandidate,
    );
    const extractedIdsByScript = pixelCandidateScripts.map((script) =>
        extractFacebookPixelIdsFromScript(script.config),
    );
    const activeBrowserPixelIds = unique(extractedIdsByScript.flat()).sort();
    const activeFacebookPixelScriptCount = pixelCandidateScripts.length;
    const parseableFacebookPixelScriptCount = extractedIdsByScript.filter(
        (ids) => ids.length > 0,
    ).length;

    if (!trimmedCapiPixelId) {
        return {
            status: "not_configured",
            severity: "neutral",
            message:
                "Save a Meta Pixel ID to compare server-side CAPI with the active browser Pixel.",
            capiPixelId: null,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    if (!normalizedCapiPixelId) {
        return {
            status: "invalid_capi_pixel_id",
            severity: "warning",
            message:
                "The CAPI Pixel ID is not a numeric Meta Pixel ID, so browser/server parity cannot be trusted.",
            capiPixelId: trimmedCapiPixelId,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    if (activeFacebookPixelScriptCount === 0) {
        return {
            status: "no_browser_pixel",
            severity: "warning",
            message:
                "No active Facebook Pixel script is configured. Purchase CAPI can still send, but browser/server deduplication cannot be verified.",
            capiPixelId: normalizedCapiPixelId,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    if (activeBrowserPixelIds.length === 0) {
        return {
            status: "unreadable_browser_pixel",
            severity: "warning",
            message:
                "An active Facebook Pixel script exists, but no fbq('init', '...') Pixel ID could be read from it.",
            capiPixelId: normalizedCapiPixelId,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    const browserHasCapiPixel = activeBrowserPixelIds.includes(normalizedCapiPixelId);

    if (!browserHasCapiPixel) {
        return {
            status: "mismatch",
            severity: "warning",
            message:
                "The CAPI Pixel ID does not match any active browser Facebook Pixel script. Meta may count browser and server purchases separately.",
            capiPixelId: normalizedCapiPixelId,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    if (activeBrowserPixelIds.length > 1) {
        return {
            status: "multiple_browser_pixels",
            severity: "warning",
            message:
                "CAPI matches one active browser Pixel, but multiple browser Pixel IDs are active. Confirm this is intentional before relying on deduplication.",
            capiPixelId: normalizedCapiPixelId,
            activeBrowserPixelIds,
            activeFacebookPixelScriptCount,
            parseableFacebookPixelScriptCount,
        };
    }

    return {
        status: "ok",
        severity: "success",
        message:
            "The CAPI Pixel ID matches the active browser Facebook Pixel ID.",
        capiPixelId: normalizedCapiPixelId,
        activeBrowserPixelIds,
        activeFacebookPixelScriptCount,
        parseableFacebookPixelScriptCount,
    };
}

export function buildUnavailableMetaPixelParityDiagnostics(
    capiPixelId: string | null | undefined,
): MetaPixelParityDiagnostics {
    return {
        status: "unavailable",
        severity: "warning",
        message:
            "The Pixel match check could not run. CAPI settings are still saved, but browser/server parity was not verified.",
        capiPixelId: capiPixelId?.trim() || null,
        activeBrowserPixelIds: [],
        activeFacebookPixelScriptCount: 0,
        parseableFacebookPixelScriptCount: 0,
    };
}

export async function getMetaPixelParityDiagnostics(
    db: Database,
    capiPixelId: string | null | undefined,
): Promise<MetaPixelParityDiagnostics> {
    const scripts = await db
        .select({ config: analytics.config, type: analytics.type })
        .from(analytics)
        .where(eq(analytics.isActive, true))
        .all();

    return buildMetaPixelParityDiagnostics(capiPixelId, scripts);
}
