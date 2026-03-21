// src/modules/settings/business-settings.service.ts
// DB operations for business info settings (company details, tax ID, invoice config).
// Used by the invoice template and Organization JSON-LD.

import { settings } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { upsertSetting } from "../payments/gateway-settings";

// ─────────────────────────────────────────
// Types
// ─────────────────────────────────────────

export interface BusinessInfo {
    companyName: string;
    legalName: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    stateRegion: string;
    postalCode: string;
    country: string;
    phone: string;
    email: string;
    taxId: string;
    invoicePrefix: string;
    invoiceFooterText: string;
    invoiceLogoUrl: string;
}

// ─────────────────────────────────────────
// Key mappings (DB snake_case <-> TS camelCase)
// ─────────────────────────────────────────

const KEY_MAP: Record<keyof BusinessInfo, string> = {
    companyName: "company_name",
    legalName: "legal_name",
    addressLine1: "address_line1",
    addressLine2: "address_line2",
    city: "city",
    stateRegion: "state_region",
    postalCode: "postal_code",
    country: "country",
    phone: "phone",
    email: "email",
    taxId: "tax_id",
    invoicePrefix: "invoice_prefix",
    invoiceFooterText: "invoice_footer_text",
    invoiceLogoUrl: "invoice_logo_url",
};

const CATEGORY = "business_info";

// ─────────────────────────────────────────
// Read
// ─────────────────────────────────────────

export async function getBusinessSettings(db: Database): Promise<BusinessInfo> {
    const rows = await db
        .select({ key: settings.key, value: settings.value })
        .from(settings)
        .where(eq(settings.category, CATEGORY))
        .all();

    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));

    return {
        companyName: map["company_name"] ?? "",
        legalName: map["legal_name"] ?? "",
        addressLine1: map["address_line1"] ?? "",
        addressLine2: map["address_line2"] ?? "",
        city: map["city"] ?? "",
        stateRegion: map["state_region"] ?? "",
        postalCode: map["postal_code"] ?? "",
        country: map["country"] ?? "Bangladesh",
        phone: map["phone"] ?? "",
        email: map["email"] ?? "",
        taxId: map["tax_id"] ?? "",
        invoicePrefix: map["invoice_prefix"] ?? "INV",
        invoiceFooterText: map["invoice_footer_text"] ?? "",
        invoiceLogoUrl: map["invoice_logo_url"] ?? "",
    };
}

// ─────────────────────────────────────────
// Write
// ─────────────────────────────────────────

export async function saveBusinessSettings(
    db: Database,
    data: Partial<BusinessInfo>,
): Promise<void> {
    const ops: Promise<void>[] = [];

    for (const [camelKey, snakeKey] of Object.entries(KEY_MAP)) {
        const value = data[camelKey as keyof BusinessInfo];
        if (typeof value === "string") {
            ops.push(upsertSetting(db, CATEGORY, snakeKey, value.trim()));
        }
    }

    await Promise.all(ops);
}
