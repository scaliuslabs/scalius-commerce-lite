// src/modules/settings/business-settings.service.ts
// Business identity (invoice template, Organization/OnlineStore JSON-LD).

import { z } from "zod";
import { buildBatchGuard, type Database } from "@scalius/database/client";
import { ConflictError, ValidationError } from "../../errors";
import {
    isMediaReferenceDeletingGuardError,
    MEDIA_REFERENCE_DELETING_MESSAGE,
    noDeletingMediaReferences,
} from "../media/media-reference-guard";
import { businessDocument, type BusinessInfo } from "./documents";

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

export async function getBusinessSettings(db: Database): Promise<BusinessInfo> {
    return businessDocument.read(db);
}

export async function saveBusinessSettings(
    db: Database,
    data: Partial<BusinessInfo>,
): Promise<void> {
    const patch: Partial<BusinessInfo> = {};
    for (const field of Object.keys(businessDocument.defaults) as Array<keyof BusinessInfo>) {
        const value = data[field];
        if (typeof value !== "string") continue;
        patch[field] = field === "email" ? normalizeBusinessEmail(value) : value.trim();
    }
    if (Object.keys(patch).length === 0) return;

    const mediaGuard = patch.invoiceLogoUrl ? noDeletingMediaReferences(patch.invoiceLogoUrl) : undefined;
    try {
        await businessDocument.write(db, patch, {}, {
            before: mediaGuard ? [buildBatchGuard(db, mediaGuard, "MEDIA_REFERENCE_DELETING")] : [],
        });
    } catch (error) {
        if (isMediaReferenceDeletingGuardError(error)) {
            throw new ConflictError(MEDIA_REFERENCE_DELETING_MESSAGE);
        }
        throw error;
    }
}
