// Stored customer notification templates (the `notification_templates`
// settings document). Only the copy a merchant changed is stored.

import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import { notificationTemplatesDocument } from "../settings/documents";
import type { OrderNotificationType } from "./notification-types";
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  TEMPLATE_LIMITS,
  findUnknownVariables,
  resolveNotificationTemplates,
  type EmailTemplate,
  type NotificationTemplates,
  type SmsTemplate,
} from "./notification-templates";

export async function getNotificationTemplates(
  db: Database,
): Promise<{ templates: NotificationTemplates; revision: number }> {
  const { value, revision } = await notificationTemplatesDocument.readDetailed(db);
  return { templates: resolveNotificationTemplates(value), revision };
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
 * Saves one event's email and/or SMS copy. Copy equal to the default is not
 * stored, so a later change to the default reaches this store too.
 */
export async function saveNotificationTemplate(
  db: Database,
  input: { event: OrderNotificationType; email?: EmailTemplate; sms?: SmsTemplate },
  options: { expectedRevision: number },
): Promise<{ templates: NotificationTemplates; revision: number }> {
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

  const current = (await notificationTemplatesDocument.readDetailed(db)).value;
  const emailOverrides = { ...current.email };
  const smsOverrides = { ...current.sms };
  if (email) {
    const fallback = DEFAULT_NOTIFICATION_TEMPLATES.email[event];
    if (email.subject === fallback.subject && email.body === fallback.body) delete emailOverrides[event];
    else emailOverrides[event] = email;
  }
  if (sms) {
    if (sms.body === DEFAULT_NOTIFICATION_TEMPLATES.sms[event].body) delete smsOverrides[event];
    else smsOverrides[event] = sms;
  }

  const { value, revision } = await notificationTemplatesDocument.write(
    db,
    { email: emailOverrides, sms: smsOverrides },
    {},
    { expectedRevision: options.expectedRevision },
  );
  return { templates: resolveNotificationTemplates(value), revision };
}
