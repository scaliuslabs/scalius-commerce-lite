// src/modules/settings/business-settings.service.ts
// Business identity (invoice template, Organization/OnlineStore JSON-LD).

import { z } from "zod";
import { buildBatchGuard, type Database } from "@scalius/database/client";
import { ConflictError, ValidationError } from "../../errors";
import {
  isMediaReferenceDeletingGuardError,
  MEDIA_REFERENCE_DELETING_MESSAGE,
  noDeletingMediaReferences,
} from "../media-references";
import { normalizeBdLandline, validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { normalizeBdMobile } from "@scalius/shared/phone-input";
import { normalizePublicMediaUrl } from "@scalius/shared/media-url";
import {
    BUSINESS_SOCIAL_LINKS_MAX,
    businessDocument,
    customerCountriesDocument,
    type BusinessInfo,
    type BusinessSocialLink,
} from "./documents";
import type { SettingsDocumentWriteResult } from "../../settings-store";

export type { BusinessInfo } from "./documents";

const businessEmailSchema = z.email();

export function normalizeBusinessEmail(value: string): string {
    const normalized = value.trim();
    if (normalized === "") return "";
    const result = businessEmailSchema.safeParse(normalized);
    if (!result.success) {
        throw new ValidationError("Enter a valid business support email address.");
    }
    return result.data;
}

type ContactIssue = { path: [keyof BusinessInfo, ...Array<string | number>]; message: string };

function httpsProfileUrl(value: string): string | null {
    try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password ? url.toString() : null;
    } catch {
        return null;
    }
}

/**
 * The store's social profiles, in order: an id, a label, an https URL and an
 * optional icon from Files. Every problem is reported against its field.
 */
function normalizeSocialLinks(links: readonly BusinessSocialLink[], issues: ContactIssue[]): BusinessSocialLink[] {
    if (links.length > BUSINESS_SOCIAL_LINKS_MAX) {
        issues.push({ path: ["socialLinks"], message: `List at most ${BUSINESS_SOCIAL_LINKS_MAX} social profiles.` });
        return [];
    }
    const ids = new Set<string>();
    return links.map((link, index) => {
        const id = String(link.id ?? "").trim();
        if (!id || id.length > 128 || ids.has(id)) {
            issues.push({ path: ["socialLinks", index, "id"], message: "Each social profile needs its own id." });
        }
        ids.add(id);
        const url = httpsProfileUrl(String(link.url ?? "").trim());
        if (!url) issues.push({ path: ["socialLinks", index, "url"], message: "Use the profile's https:// address." });
        const iconUrl = link.iconUrl?.trim() ? normalizePublicMediaUrl(link.iconUrl.trim()) : null;
        if (link.iconUrl?.trim() && !iconUrl) {
            issues.push({ path: ["socialLinks", index, "iconUrl"], message: "Choose the icon from Files." });
        }
        return { id, label: String(link.label ?? "").trim().slice(0, 200), url: url ?? "", ...(iconUrl ? { iconUrl } : {}) };
    });
}

/**
 * The store's contact phone: a Bangladesh mobile in any typing becomes
 * 01XXXXXXXXX (as printed on invoices); a Bangladesh landline (02-9876543)
 * or any other number, a full international one from a country the store
 * accepts, is stored as E.164.
 */
async function normalizeBusinessPhone(db: Database, value: string): Promise<string | ContactIssue> {
    if (value === "") return "";
    // Buyer phones must be mobiles (couriers call, codes go by SMS); the store's
    // own contact number may be a landline.
    const landline = normalizeBdLandline(value);
    if (landline) return landline;
    const countries = await customerCountriesDocument.read(db);
    try {
        const e164 = validateAndFormatPhone(value, {
            countries: countries.allowedCountries,
            mode: countries.allowedCountriesMode,
        });
        const mobile = normalizeBdMobile(e164);
        return mobile ? `0${mobile.slice(4)}` : e164;
    } catch (error) {
        const notAccepted = error instanceof Error && error.message.includes("not accepted");
        return {
            path: ["phone"],
            message: notAccepted
                ? "Numbers from this country aren't accepted. Change it in Customer countries."
                : "Enter a number like 01712-345678 or 02-9876543, or a full number starting with +.",
        };
    }
}

export async function getBusinessSettings(db: Database): Promise<BusinessInfo> {
    return businessDocument.read(db);
}

/** The stored document and the revision a save must send back. */
export async function getBusinessSettingsDocument(
    db: Database,
): Promise<BusinessInfo & { revision: number }> {
    const { value, revision } = await businessDocument.readDetailed(db);
    return { ...value, revision };
}

export async function saveBusinessSettings(
    db: Database,
    data: Partial<BusinessInfo>,
    options: { expectedRevision?: number } = {},
): Promise<SettingsDocumentWriteResult<BusinessInfo>> {
    const patch: Partial<BusinessInfo> = {};
    for (const field of Object.keys(businessDocument.defaults) as Array<keyof BusinessInfo>) {
        const value = data[field];
        // Social links are a list, normalized below; every other field is text.
        if (field !== "socialLinks" && typeof value === "string") (patch as Record<string, unknown>)[field] = value.trim();
    }

    // Every contact problem at once, each against its field.
    const issues: ContactIssue[] = [];
    if (Array.isArray(data.socialLinks)) patch.socialLinks = normalizeSocialLinks(data.socialLinks, issues);
    if (patch.email) {
        const email = businessEmailSchema.safeParse(patch.email);
        if (email.success) patch.email = email.data;
        else issues.push({ path: ["email"], message: "Enter an email like hello@yourshop.com." });
    }
    if (patch.phone !== undefined) {
        const phone = await normalizeBusinessPhone(db, patch.phone);
        if (typeof phone === "string") patch.phone = phone;
        else issues.push(phone);
    }
    if (issues.length > 0) {
        throw new ValidationError(issues.map((issue) => issue.message).join(" "), { issues });
    }

    const mediaUrls = [patch.invoiceLogoUrl ?? "", ...(patch.socialLinks ?? []).map((link) => link.iconUrl ?? "")]
        .filter(Boolean).join(" ");
    const mediaGuard = mediaUrls ? noDeletingMediaReferences(mediaUrls) : undefined;
    try {
        return await businessDocument.write(db, patch, {}, {
            expectedRevision: options.expectedRevision,
            before: mediaGuard ? [buildBatchGuard(db, mediaGuard, "MEDIA_REFERENCE_DELETING")] : [],
        });
    } catch (error) {
        if (isMediaReferenceDeletingGuardError(error)) {
            throw new ConflictError(MEDIA_REFERENCE_DELETING_MESSAGE);
        }
        throw error;
    }
}
