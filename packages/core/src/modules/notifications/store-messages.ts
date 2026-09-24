// Store identity for buyer and staff messages (name, logo, language) and the
// one-time-code message built from it.
import type { Database } from "@scalius/database/client";
import { checkoutLanguages } from "@scalius/database/schema";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { escapeHtml } from "@scalius/shared/html-escape";
import { mediaOriginalUrl } from "@scalius/shared/media-variants";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import { and, eq, isNull } from "drizzle-orm";
import { businessDocument, headerDocument, platformDocument, type BusinessInfo } from "../settings/documents";
import { selectSettingsDocuments } from "../settings/settings-store";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
import { storeHeaderHtml, type EmailStore } from "./notification-templates";

export interface StoreIdentity extends EmailStore {
  /** Bangla when the active checkout language is Bangla, else English. */
  language: MessageLanguage;
  business: BusinessInfo;
  /** True when no business name is set and `name` is the Store URL's host. */
  nameFromAddress: boolean;
}

/**
 * The store's name in every buyer and staff message (headers, sender name,
 * `{{store_name}}`): the business name, else the legal name, else the Store
 * URL's host (e.g. `shop.example.com`). Null only while none of them is set.
 */
export function storeDisplayName(
  business: Pick<BusinessInfo, "companyName" | "legalName">,
  storefrontUrl: string,
): string | null {
  const businessName = business.companyName.trim() || business.legalName.trim();
  if (businessName) return businessName;
  const origin = normalizeStorefrontOrigin(storefrontUrl);
  return origin ? new URL(origin).host.replace(/^www\./, "") : null;
}

/** Only the store's display name, for staff emails. A failed read returns null: the email still goes, unbranded. */
export async function readStoreName(db: Database): Promise<string | null> {
  try {
    const rows = await selectSettingsDocuments(db, [businessDocument, platformDocument]);
    const [business, platform] = await Promise.all([businessDocument.fromRows(rows), platformDocument.fromRows(rows)]);
    return storeDisplayName(business.value, platform.value.storefrontUrl);
  } catch {
    return null;
  }
}

/** Bangla when the active checkout language is Bangla, else English. */
export async function readStoreLanguage(db: Database): Promise<MessageLanguage> {
  const [activeLanguage] = await db.select({ code: checkoutLanguages.code }).from(checkoutLanguages)
    .where(and(eq(checkoutLanguages.isActive, true), isNull(checkoutLanguages.deletedAt)))
    .limit(1);
  return checkoutLanguageBaseCode(activeLanguage?.code) === "bn" ? "bn" : "en";
}

export async function readStoreIdentity(db: Database): Promise<StoreIdentity> {
  const [rows, language] = await Promise.all([
    selectSettingsDocuments(db, [businessDocument, headerDocument, platformDocument]),
    readStoreLanguage(db),
  ]);
  const [business, header, platform] = await Promise.all([
    businessDocument.fromRows(rows),
    headerDocument.fromRows(rows),
    platformDocument.fromRows(rows),
  ]);
  const logo = header.value.logo as { src?: unknown } | undefined;
  const name = storeDisplayName(business.value, platform.value.storefrontUrl);
  return {
    name,
    logoUrl: typeof logo?.src === "string" ? absoluteHttpUrl(mediaOriginalUrl(logo.src.trim())) : null,
    language,
    business: business.value,
    nameFromAddress: name !== null && !storeDisplayName(business.value, ""),
  };
}

function absoluteHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * One code message for every buyer code purpose. Sign-in and sign-up share one
 * flow and one wording; payment recovery and order lookup name their action.
 */
export function composeAuthOtpMessage(
  store: Pick<StoreIdentity, "name" | "logoUrl" | "language">,
  input: { purpose: string | undefined; code: string; name: string },
) {
  const copy = MESSAGE_COPY[store.language];
  const intro = copy.otp.intro[
    input.purpose === "order_payment_recovery" || input.purpose === "order_lookup" ? input.purpose : "sign_in"
  ](store.name);
  const greeting = copy.greeting(input.name.trim());
  const subject = copy.otp.subject(input.code, store.name).replace(/[\r\n]+/g, " ");
  const html = `<!doctype html><html lang="${store.language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>
<body style="margin:0;background:#ffffff;">
<div role="main" style="max-width:560px;margin:0 auto;padding:24px 20px;overflow-wrap:anywhere;background:#ffffff;color:#202124;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;">
${storeHeaderHtml(store)}
<p style="margin:0 0 8px;">${escapeHtml(greeting)}</p><p style="margin:0 0 24px;">${escapeHtml(intro)}</p>
<p style="margin:0 0 24px;padding:20px;background:#f1f3f4;border-radius:8px;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;font-family:'Courier New',monospace;">${escapeHtml(input.code)}</p>
<p style="margin:0 0 8px;">${escapeHtml(copy.otp.expires)}</p>
<p style="margin:0;color:#5f6368;font-size:14px;">${escapeHtml(copy.otp.ignore)}</p>
</div></body></html>`;
  return {
    subject,
    html,
    text: [store.name, greeting, intro, input.code, copy.otp.expires, copy.otp.ignore].filter(Boolean).join("\n\n"),
    sms: copy.otp.sms(input.code, store.name),
    fromName: store.name ?? undefined,
  };
}
