// Stored customer notification templates (the `notification_templates`
// settings document). Only the copy a merchant changed is stored.

import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { notificationTemplatesDocument } from "./documents";
import type { MessageLanguage } from "./message-copy";
import type { TemplatedNotificationType } from "./notification-types";
import {
  TEMPLATE_LIMITS,
  defaultNotificationTemplates,
  findUnknownVariables,
  resolveNotificationTemplates,
  type EmailTemplate,
  type NotificationTemplates,
  type SmsTemplate,
} from "./notification-templates";
import { messageLanguageOf, readStoreLanguage, readStoreLocales } from "./store-messages";
import { formatNumber } from "@scalius/shared/locale-format";

/**
 * The templates in effect for a message: the merchant's changes over the
 * defaults of `language` (the store's unless the caller knows the buyer's),
 * and the merchant's version in the buyer's `locale` over those, field by
 * field through `translationChain()`.
 */
export async function getNotificationTemplates(
  db: Database,
  knownLanguage?: MessageLanguage,
  options: { locale?: string | null } = {},
): Promise<{ templates: NotificationTemplates; revision: number; language: MessageLanguage }> {
  const [{ value, revision }, language] = await Promise.all([
    notificationTemplatesDocument.readDetailed(db),
    knownLanguage ?? readStoreLanguage(db),
  ]);
  return { templates: resolveNotificationTemplates(value, language, options.locale), revision, language };
}

/** The editor's view of one language: its templates, and the store's languages to choose from. */
export interface NotificationTemplatesInLanguage {
  templates: NotificationTemplates;
  revision: number;
  /** The message copy (and email frame) of the language shown. */
  language: MessageLanguage;
  /** The language shown: null for the store's default language. */
  locale: string | null;
  defaultLocale: string;
  /** The store's languages (`store_languages`); a template has a version in each. */
  locales: Array<{ locale: string; published: boolean }>;
}

/** The locale a request names, when it is one of the store's other languages; null: the default. */
function otherLocale(locale: string | null | undefined, stored: { defaultLocale: string; locales: Array<{ locale: string }> }): string | null {
  return locale && locale !== stored.defaultLocale && stored.locales.some((each) => each.locale === locale) ? locale : null;
}

/** The templates as the editor shows them in one of the store's languages (the default when none or unknown). */
export async function getNotificationTemplatesInLanguage(db: Database, locale?: string | null): Promise<NotificationTemplatesInLanguage> {
  const [{ value, revision }, storeLanguage, stored] = await Promise.all([
    notificationTemplatesDocument.readDetailed(db),
    readStoreLanguage(db),
    readStoreLocales(db),
  ]);
  const shown = otherLocale(locale, stored);
  const language = shown ? messageLanguageOf({ language: storeLanguage }, shown) : storeLanguage;
  return {
    templates: resolveNotificationTemplates(value, language, shown),
    revision,
    language,
    locale: shown,
    defaultLocale: stored.defaultLocale,
    locales: stored.locales,
  };
}

type Issue = { path: Array<string | number>; message: string };

function checkText(
  issues: Issue[],
  path: Array<string | number>,
  value: string,
  max: number,
  event: TemplatedNotificationType,
): void {
  if (!value.trim()) {
    issues.push({ path, message: "Enter some text." });
    return;
  }
  if (value.length > max) {
    issues.push({ path, message: `Use ${formatNumber(max, "en")} characters or fewer.` });
    return;
  }
  const unknown = findUnknownVariables(value, event);
  if (unknown.length > 0) {
    const names = unknown.map((name) => `{{${name}}}`).join(", ");
    issues.push({
      path,
      message: unknown.length === 1
        ? `${names} isn't a variable this message can use.`
        : `${names} aren't variables this message can use.`,
    });
  }
}

/**
 * Saves one event's email and/or SMS copy. Copy equal to the default of the
 * store's language is not stored, so a later change to the default (or to the
 * checkout language) reaches this store too.
 */
export async function saveNotificationTemplate(
  db: Database,
  input: {
    event: TemplatedNotificationType;
    email?: EmailTemplate;
    sms?: SmsTemplate;
    /** One of the store's other languages: saves that language's version; absent, the default language's. */
    locale?: string | null;
  },
  options: { expectedRevision: number },
): Promise<{ templates: NotificationTemplates; revision: number; language: MessageLanguage }> {
  const { event } = input;
  const email = input.email && {
    subject: input.email.subject.replace(/[\r\n]+/g, " ").trim(),
    body: input.email.body.replace(/\r\n?/g, "\n").trim(),
  };
  const sms = input.sms && { body: input.sms.body.replace(/\r\n?/g, "\n").trim() };

  const issues: Issue[] = [];
  if (email) {
    checkText(issues, ["email", "subject"], email.subject, TEMPLATE_LIMITS.subject, event);
    checkText(issues, ["email", "body"], email.body, TEMPLATE_LIMITS.emailBody, event);
  }
  if (sms) checkText(issues, ["sms", "body"], sms.body, TEMPLATE_LIMITS.smsBody, event);
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, { issues });

  const [current, language, stored] = await Promise.all([
    notificationTemplatesDocument.readDetailed(db).then((document) => document.value),
    readStoreLanguage(db),
    readStoreLocales(db),
  ]);
  const locale = otherLocale(input.locale, stored);
  if (input.locale && input.locale !== stored.defaultLocale && !locale) {
    throw new ValidationError("That isn't one of the store's languages.", { issues: [{ path: ["locale"], message: "Choose one of the store's languages." }] });
  }
  if (locale) {
    // Another language's version keeps only what differs from its fallback,
    // the default-language template (the merchant's, else the platform's).
    const shownLanguage = messageLanguageOf({ language }, locale);
    const fallback = resolveNotificationTemplates({ email: current.email, sms: current.sms }, shownLanguage);
    const languages = { ...current.languages };
    const version = { email: { ...languages[locale]?.email }, sms: { ...languages[locale]?.sms } };
    if (email) {
      const own = {
        ...(email.subject !== fallback.email[event].subject ? { subject: email.subject } : {}),
        ...(email.body !== fallback.email[event].body ? { body: email.body } : {}),
      };
      if (Object.keys(own).length > 0) version.email[event] = own;
      else delete version.email[event];
    }
    if (sms) {
      if (sms.body !== fallback.sms[event].body) version.sms[event] = { body: sms.body };
      else delete version.sms[event];
    }
    if (Object.keys(version.email).length + Object.keys(version.sms).length > 0) languages[locale] = version;
    else delete languages[locale];
    const { value, revision } = await notificationTemplatesDocument.write(
      db,
      { email: current.email, sms: current.sms, ...(Object.keys(languages).length > 0 ? { languages } : {}) },
      {},
      { expectedRevision: options.expectedRevision },
    );
    return { templates: resolveNotificationTemplates(value, shownLanguage, locale), revision, language: shownLanguage };
  }
  const defaults = defaultNotificationTemplates(language);
  const emailOverrides = { ...current.email };
  const smsOverrides = { ...current.sms };
  if (email) {
    const fallback = defaults.email[event];
    if (email.subject === fallback.subject && email.body === fallback.body) delete emailOverrides[event];
    else emailOverrides[event] = email;
  }
  if (sms) {
    if (sms.body === defaults.sms[event].body) delete smsOverrides[event];
    else smsOverrides[event] = sms;
  }

  const { value, revision } = await notificationTemplatesDocument.write(
    db,
    { email: emailOverrides, sms: smsOverrides, ...(current.languages ? { languages: current.languages } : {}) },
    {},
    { expectedRevision: options.expectedRevision },
  );
  return { templates: resolveNotificationTemplates(value, language), revision, language };
}
