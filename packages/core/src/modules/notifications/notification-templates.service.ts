// Stored customer notification templates (the `notification_templates`
// settings document). Only the copy a merchant changed is stored.

import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { notificationTemplatesDocument } from "../settings/documents";
import type { MessageLanguage } from "./message-copy";
import type { OrderNotificationType } from "./notification-types";
import {
  TEMPLATE_LIMITS,
  defaultNotificationTemplates,
  findUnknownVariables,
  resolveNotificationTemplates,
  type EmailTemplate,
  type NotificationTemplates,
  type SmsTemplate,
} from "./notification-templates";
import { readStoreLanguage } from "./store-messages";

/**
 * The templates in effect: the merchant's changes over the defaults of the
 * store's checkout language (read here unless the caller already knows it).
 */
export async function getNotificationTemplates(
  db: Database,
  knownLanguage?: MessageLanguage,
): Promise<{ templates: NotificationTemplates; revision: number; language: MessageLanguage }> {
  const [{ value, revision }, language] = await Promise.all([
    notificationTemplatesDocument.readDetailed(db),
    knownLanguage ?? readStoreLanguage(db),
  ]);
  return { templates: resolveNotificationTemplates(value, language), revision, language };
}

type Issue = { path: Array<string | number>; message: string };

function checkText(
  issues: Issue[],
  path: Array<string | number>,
  value: string,
  max: number,
  event: OrderNotificationType,
): void {
  if (!value.trim()) {
    issues.push({ path, message: "Enter some text." });
    return;
  }
  if (value.length > max) {
    issues.push({ path, message: `Use ${max.toLocaleString("en-US")} characters or fewer.` });
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
  input: { event: OrderNotificationType; email?: EmailTemplate; sms?: SmsTemplate },
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

  const [current, language] = await Promise.all([
    notificationTemplatesDocument.readDetailed(db).then((document) => document.value),
    readStoreLanguage(db),
  ]);
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
    { email: emailOverrides, sms: smsOverrides },
    {},
    { expectedRevision: options.expectedRevision },
  );
  return { templates: resolveNotificationTemplates(value, language), revision, language };
}
