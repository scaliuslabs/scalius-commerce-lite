// Store identity for buyer and staff messages (name, logo, language) and the
// one-time-code message built from it.
import { safeBatch, type Database } from "@scalius/database/client";
import { marketPresences, media, themeSettings } from "@scalius/database/schema";
import { checkoutLanguageBaseCode } from "@scalius/shared/checkout-language";
import { escapeHtml } from "@scalius/shared/html-escape";
import { formatOrderNumber } from "@scalius/shared/order-utils";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { getCurrentPublicMediaUrl } from "../../integrations/storage";
import { businessDocument, type BusinessInfo, storeDisplayName } from "../settings";
import { platformDocument } from "../platform";
import { selectSettingsDocuments } from "../../settings-store";
import { MESSAGE_COPY, type MessageLanguage } from "./message-copy";
import { storeHeaderHtml, type EmailStore } from "./notification-templates";

export interface StoreIdentity extends EmailStore {
  /** Bangla when the store default language is Bangla, else English. */
  language: MessageLanguage;
  business: BusinessInfo;
  /** True when no business name is set and `name` is the Store URL's host. */
  nameFromAddress: boolean;
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

/** Bangla when the store default language (the root presence's, MARKETS-DESIGN D9) is Bangla, else English. */
export async function readStoreLanguage(db: Database): Promise<MessageLanguage> {
  const [root] = await db.select({ locale: marketPresences.locale }).from(marketPresences)
    .where(and(eq(marketPresences.kind, "subfolder"), eq(marketPresences.value, "")))
    .limit(1);
  return checkoutLanguageBaseCode(root?.locale) === "bn" ? "bn" : "en";
}

/**
 * The published theme's logo as its original upload (mail clients get the
 * file as uploaded, not a WebP rendition); null without a logo.
 */
function selectPublishedLogo(db: Database) {
  return db.select({ objectKey: media.objectKey, kind: media.kind }).from(media).where(and(
    sql`${media.id} = (SELECT json_extract(${themeSettings.colors}, '$.brand.logo') FROM ${themeSettings} WHERE ${themeSettings.id} = 'default')`,
    notInArray(media.status, ["deleting", "deleted"]),
  )).limit(1);
}

export async function readStoreIdentity(db: Database): Promise<StoreIdentity> {
  const [[rows, logoRows], language] = await Promise.all([
    safeBatch(db, [
      selectSettingsDocuments(db, [businessDocument, platformDocument]),
      selectPublishedLogo(db),
    ]),
    readStoreLanguage(db),
  ]);
  const [business, platform] = await Promise.all([
    businessDocument.fromRows(rows as Awaited<ReturnType<typeof selectSettingsDocuments>>),
    platformDocument.fromRows(rows as Awaited<ReturnType<typeof selectSettingsDocuments>>),
  ]);
  const logo = (logoRows as Array<{ objectKey: string; kind: string }>).find((row) => row.kind === "image");
  const name = storeDisplayName(business.value, platform.value.storefrontUrl);
  return {
    name,
    // Messages leave the request (queues, cron): the Platform media URL makes the logo absolute.
    logoUrl: logo ? absoluteHttpUrl(getCurrentPublicMediaUrl(logo.objectKey, platform.value.mediaUrl.trim() || undefined)) : null,
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
  input: { purpose: string | undefined; code: string; name: string; orderNumber?: number | null },
) {
  const copy = MESSAGE_COPY[store.language];
  const intro = copy.otp.intro[
    input.purpose === "order_payment_recovery" || input.purpose === "order_lookup" ? input.purpose : "sign_in"
  ](store.name, input.orderNumber ? formatOrderNumber(input.orderNumber, "") : null);
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
