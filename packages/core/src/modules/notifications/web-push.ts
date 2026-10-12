// Web Push (docs/platform/PLUGINS.md, "Push"): browsers that asked for
// notifications, for staff (the dashboard) and signed-in buyers (the
// storefront), and the delivery to them. The platform signs with VAPID
// (RFC 8292) using a key pair derived from SCALIUS_SECRET (no push service
// account, no new secret) and encrypts each message for its browser
// (RFC 8291). A push service that answers 404 or 410 has dropped the
// subscription: it is deleted. Endpoints, keys and payloads are never logged.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { pushSubscriptions } from "@scalius/database/schema";
import { staffPermissionSql, type StaffPermissionRequirement } from "@scalius/core/auth/rbac/helpers";
import { ValidationError } from "@scalius/core/errors";
import { readMasterSecret } from "@scalius/shared/runtime-secrets";
import { providerErrorOf, type PushNotification, type PushSendInput } from "@scalius/shared/plugins/providers";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { resolveAppProvider, type AppProviders } from "../../integrations/provider-port";
import { notificationsDocument } from "./documents";
import {
  deriveVapidKeys,
  isAllowedPushEndpoint,
  MAX_WEB_PUSH_PLAINTEXT,
  sendWebPush,
  WebPushError,
  type VapidKeys,
  type WebPushOutcome,
} from "../../integrations/web-push";

/** The most browsers one person keeps subscribed; a new one replaces the oldest. */
export const PUSH_SUBSCRIPTIONS_PER_OWNER = 10;
/** Owners per read (one bound parameter each, under D1's 100). */
const OWNER_CHUNK = 90;

export type PushOwner = { audience: "staff"; userId: string } | { audience: "customer"; customerId: string };

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  deviceLabel?: string | null;
}

/** One subscription as a send reads it. */
export interface StoredPushSubscription {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** The staff owner (null for a buyer's browser). */
  userId: string | null;
  customerId: string | null;
}

/** What the dashboard shows of a staff member's own devices. */
export interface PushDevice {
  id: string;
  deviceLabel: string | null;
  lastSuccessAt: Date | null;
  createdAt: Date;
  /** Sends that failed in a row since the last delivery (0 when the last one arrived). */
  failureCount: number;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The browser's subscription (`PushSubscription.toJSON()`), checked; anything else is refused. */
export function parsePushSubscription(value: unknown): PushSubscriptionInput {
  const input = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown }; deviceLabel?: unknown } | null;
  const endpoint = typeof input?.endpoint === "string" ? input.endpoint.trim() : "";
  if (!endpoint || endpoint.length > 2048 || !isAllowedPushEndpoint(endpoint)) {
    throw new ValidationError("This browser's push service is not supported.");
  }
  const p256dh = typeof input?.keys?.p256dh === "string" ? input.keys.p256dh.replace(/=+$/, "") : "";
  const auth = typeof input?.keys?.auth === "string" ? input.keys.auth.replace(/=+$/, "") : "";
  // A 65-byte P-256 point is 87 base64url characters; a 16-byte secret 22.
  if (p256dh.length !== 87 || auth.length !== 22 || !BASE64URL.test(p256dh) || !BASE64URL.test(auth)) {
    throw new ValidationError("The browser sent an invalid push subscription.");
  }
  const label = typeof input?.deviceLabel === "string" ? input.deviceLabel.replace(/\s+/g, " ").trim().slice(0, 120) : "";
  return { endpoint, keys: { p256dh, auth }, deviceLabel: label || null };
}

function ownerCondition(owner: PushOwner) {
  return owner.audience === "staff"
    ? and(eq(pushSubscriptions.audience, "staff"), eq(pushSubscriptions.userId, owner.userId))
    : and(eq(pushSubscriptions.audience, "customer"), eq(pushSubscriptions.customerId, owner.customerId));
}

function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return `psb_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Saves a browser's subscription for its owner. The endpoint is unique: the
 * same browser subscribing again (or for another person, on a shared
 * computer) moves the row to this owner with fresh keys. Above
 * PUSH_SUBSCRIPTIONS_PER_OWNER the owner's oldest subscriptions go.
 */
export async function savePushSubscription(db: Database, owner: PushOwner, input: PushSubscriptionInput): Promise<{ id: string }> {
  const id = newId();
  const ownerColumns = owner.audience === "staff"
    ? { audience: "staff" as const, userId: owner.userId, customerId: null }
    : { audience: "customer" as const, customerId: owner.customerId, userId: null };
  const [saved] = await db.insert(pushSubscriptions).values({
    id,
    ...ownerColumns,
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    deviceLabel: input.deviceLabel ?? null,
  }).onConflictDoUpdate({
    target: pushSubscriptions.endpoint,
    set: {
      ...ownerColumns,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceLabel: input.deviceLabel ?? null,
      failureCount: 0,
      updatedAt: sql`unixepoch()`,
    },
  }).returning({ id: pushSubscriptions.id });
  // Keep the newest few: one bounded delete by the owner's index.
  await db.delete(pushSubscriptions).where(and(
    ownerCondition(owner),
    sql`${pushSubscriptions.id} NOT IN (SELECT kept.id FROM ${pushSubscriptions} AS kept
      WHERE kept.audience = ${owner.audience}
        AND ${owner.audience === "staff" ? sql`kept.user_id = ${owner.userId}` : sql`kept.customer_id = ${owner.customerId}`}
      ORDER BY kept.updated_at DESC, kept.id DESC LIMIT ${PUSH_SUBSCRIPTIONS_PER_OWNER})`,
  ));
  return { id: saved?.id ?? id };
}

/** Removes the owner's subscription of this browser; true when there was one. */
export async function deletePushSubscription(db: Database, owner: PushOwner, endpoint: string): Promise<boolean> {
  const removed = await db.delete(pushSubscriptions)
    .where(and(ownerCondition(owner), eq(pushSubscriptions.endpoint, endpoint)))
    .returning({ id: pushSubscriptions.id });
  return removed.length > 0;
}

/** Whether the owner has subscribed this browser. */
export async function hasPushSubscription(db: Database, owner: PushOwner, endpoint: string): Promise<boolean> {
  const rows = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
    .where(and(ownerCondition(owner), eq(pushSubscriptions.endpoint, endpoint))).limit(1);
  return rows.length > 0;
}

/** A staff member's subscribed browsers, newest first. */
export async function listStaffPushDevices(db: Database, userId: string): Promise<PushDevice[]> {
  const rows = await db.select({
    id: pushSubscriptions.id,
    deviceLabel: pushSubscriptions.deviceLabel,
    lastSuccessAt: pushSubscriptions.lastSuccessAt,
    createdAt: pushSubscriptions.createdAt,
    failureCount: pushSubscriptions.failureCount,
  }).from(pushSubscriptions)
    .where(ownerCondition({ audience: "staff", userId }))
    .orderBy(sql`${pushSubscriptions.updatedAt} DESC`, asc(pushSubscriptions.id));
  return rows.map((row) => ({
    id: row.id,
    deviceLabel: row.deviceLabel,
    lastSuccessAt: row.lastSuccessAt === null ? null : new Date(Number(row.lastSuccessAt) * 1_000),
    createdAt: new Date(Number(row.createdAt) * 1_000),
    failureCount: Number(row.failureCount ?? 0),
  }));
}

/**
 * Sends a test notification to one of a staff member's own browsers and
 * keeps the subscription's delivery status true (as any send does). Null
 * when the device is not theirs (or no longer exists).
 */
export async function sendStaffTestPush(
  db: Database,
  sender: WebPushSender,
  userId: string,
  deviceId: string,
  notification: Pick<PushNotification, "title" | "body">,
): Promise<WebPushOutcome | null> {
  const [subscription] = await db.select({
    id: pushSubscriptions.id,
    endpoint: pushSubscriptions.endpoint,
    p256dh: pushSubscriptions.p256dh,
    auth: pushSubscriptions.auth,
    userId: pushSubscriptions.userId,
    customerId: pushSubscriptions.customerId,
  }).from(pushSubscriptions)
    .where(and(ownerCondition({ audience: "staff", userId }), eq(pushSubscriptions.id, deviceId)))
    .limit(1);
  if (!subscription) return null;
  // One tag: a second test replaces the first on the device instead of piling up.
  const payload = webPushPayload({ ...notification, tag: "scalius-test-push" });
  return deliverWebPush(db, sender, subscription, payload, { urgency: "high" });
}

/** Removes one of a staff member's own devices by id. */
export async function deleteStaffPushDevice(db: Database, userId: string, id: string): Promise<boolean> {
  const removed = await db.delete(pushSubscriptions)
    .where(and(ownerCondition({ audience: "staff", userId }), eq(pushSubscriptions.id, id)))
    .returning({ id: pushSubscriptions.id });
  return removed.length > 0;
}

/** Who a send goes to: every staff browser, some staff, or some buyers. */
export type PushTarget =
  | {
    audience: "staff";
    userIds?: readonly string[];
    requiredPermission: StaffPermissionRequirement;
  }
  | { audience: "customer"; customerIds: readonly string[] };

/** The subscriptions a send goes to (at most PUSH_SUBSCRIPTIONS_PER_OWNER per owner). */
export async function readPushSubscriptions(db: Database, target: PushTarget): Promise<StoredPushSubscription[]> {
  const columns = {
    id: pushSubscriptions.id,
    endpoint: pushSubscriptions.endpoint,
    p256dh: pushSubscriptions.p256dh,
    auth: pushSubscriptions.auth,
    userId: pushSubscriptions.userId,
    customerId: pushSubscriptions.customerId,
  };
  const activeStaffOwner = target.audience === "staff"
    ? staffPermissionSql(pushSubscriptions.userId, target.requiredPermission)
    : undefined;
  if (target.audience === "staff" && target.userIds === undefined) {
    return db.select(columns).from(pushSubscriptions).where(and(eq(pushSubscriptions.audience, "staff"), activeStaffOwner)).orderBy(asc(pushSubscriptions.id));
  }
  const owners = [...new Set(target.audience === "staff" ? target.userIds! : target.customerIds)];
  const found: StoredPushSubscription[] = [];
  for (let start = 0; start < owners.length; start += OWNER_CHUNK) {
    const chunk = owners.slice(start, start + OWNER_CHUNK);
    found.push(...await db.select(columns).from(pushSubscriptions).where(target.audience === "staff"
      ? and(eq(pushSubscriptions.audience, "staff"), activeStaffOwner, inArray(pushSubscriptions.userId, chunk))
      : and(eq(pushSubscriptions.audience, "customer"), inArray(pushSubscriptions.customerId, chunk))));
  }
  return found;
}

/** What a send needs: the VAPID keys and subject. Null when the Worker cannot sign (no master secret or https origin). */
export interface WebPushSender {
  vapid: VapidKeys;
  subject: string;
  fetch?: typeof fetch;
}

/** The public VAPID key browsers subscribe with (base64url), or null without a master secret. */
export async function webPushPublicKey(env: { SCALIUS_SECRET?: unknown }): Promise<string | null> {
  const master = readMasterSecret(env as { SCALIUS_SECRET?: string });
  return master ? (await deriveVapidKeys(master)).publicKey : null;
}

/**
 * The sender for this Worker: VAPID keys derived from SCALIUS_SECRET, and the
 * dashboard's (else the store's) https origin as the VAPID subject push
 * services contact.
 */
export async function webPushSender(env: { SCALIUS_SECRET?: unknown; BETTER_AUTH_URL?: unknown; STOREFRONT_URL?: unknown }): Promise<WebPushSender | null> {
  const master = readMasterSecret(env as { SCALIUS_SECRET?: string });
  if (!master) return null;
  const subject = [env.BETTER_AUTH_URL, env.STOREFRONT_URL]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .map((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" ? url.origin : "";
      } catch {
        return "";
      }
    })
    .find(Boolean);
  if (!subject) return null;
  return { vapid: await deriveVapidKeys(master), subject };
}

/** The message the service workers show (`title`, `body`, `url`, `tag`). */
export function webPushPayload(
  notification: PushNotification,
  recipient?: { audience: "staff" | "customer"; id: string },
): string {
  const payload = {
    title: notification.title,
    body: notification.body,
    ...(notification.url ? { url: notification.url } : {}),
    ...(notification.tag ? { tag: notification.tag } : {}),
  };
  // Legacy workers see no outer title/body; only owner-aware workers unwrap private content.
  const encode = () => JSON.stringify(recipient ? { recipient, notification: payload } : payload);
  const encoder = new TextEncoder();
  if (encoder.encode(encode()).length <= MAX_WEB_PUSH_PLAINTEXT) return encode();

  // Fit the body by encoded JSON bytes without splitting Unicode or changing its destination.
  const body = Array.from(payload.body);
  let low = 0;
  let high = body.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    payload.body = body.slice(0, middle).join("");
    if (encoder.encode(encode()).length <= MAX_WEB_PUSH_PLAINTEXT) low = middle;
    else high = middle - 1;
  }
  payload.body = body.slice(0, low).join("");
  const result = encode();
  if (encoder.encode(result).length > MAX_WEB_PUSH_PLAINTEXT) {
    throw new WebPushError("payload_too_large", "Push metadata is too large.");
  }
  return result;
}

/**
 * Sends one message to one subscription and keeps the table true: `gone`
 * deletes it, a success resets its failures, other failures remain diagnostic.
 * The outbox owns retries; a provider outage must not unsubscribe a browser.
 */
export async function deliverWebPush(
  db: Database,
  sender: WebPushSender,
  subscription: StoredPushSubscription,
  payload: string,
  options: { topic?: string; urgency?: "normal" | "high" } = {},
): Promise<WebPushOutcome> {
  let outcome: WebPushOutcome;
  try {
    const recipient = subscription.userId && !subscription.customerId
      ? { audience: "staff" as const, id: subscription.userId }
      : subscription.customerId && !subscription.userId
        ? { audience: "customer" as const, id: subscription.customerId }
        : null;
    if (!recipient) throw new Error("Push recipient is unavailable.");
    const guardedPayload = webPushPayload(JSON.parse(payload) as PushNotification, recipient);
    ({ outcome } = await sendWebPush({
      subscription: { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload: guardedPayload,
      vapid: sender.vapid,
      subject: sender.subject,
      ...(options.topic ? { topic: options.topic } : {}),
      urgency: options.urgency ?? "normal",
      ...(sender.fetch ? { fetch: sender.fetch } : {}),
    }));
  } catch (error) {
    outcome = error instanceof WebPushError && error.code === "invalid_subscriber_key" ? "gone" : "retry";
  }
  if (outcome === "gone") {
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, subscription.id));
  } else if (outcome === "sent") {
    await db.update(pushSubscriptions)
      .set({ failureCount: 0, lastSuccessAt: sql`unixepoch()` })
      .where(eq(pushSubscriptions.id, subscription.id));
  } else {
    await db.update(pushSubscriptions)
      .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
      .where(eq(pushSubscriptions.id, subscription.id));
  }
  return outcome;
}

export interface WebPushSendResult {
  subscriptions: number;
  sent: number;
  removed: number;
  failed: number;
}

/** Sends one notification to every subscription of the target, four at a time (D1 allows six connections). */
export async function sendWebPushNotification(
  db: Database,
  sender: WebPushSender,
  target: PushTarget,
  notification: PushNotification,
): Promise<WebPushSendResult> {
  const subscriptions = await readPushSubscriptions(db, target);
  const result: WebPushSendResult = { subscriptions: subscriptions.length, sent: 0, removed: 0, failed: 0 };
  const payload = webPushPayload(notification);
  for (let start = 0; start < subscriptions.length; start += 4) {
    const outcomes = await Promise.all(subscriptions.slice(start, start + 4).map((subscription) => deliverWebPush(db, sender, subscription, payload)));
    for (const outcome of outcomes) {
      if (outcome === "sent") result.sent += 1;
      else if (outcome === "gone") result.removed += 1;
      else result.failed += 1;
    }
  }
  return result;
}

/** What an app push provider answered (a failure is never thrown). */
export interface AppPushResult {
  success: boolean;
  providerRef?: string;
  rawStatus?: string;
  retryable?: boolean;
}

/**
 * One send through an app push provider (the `push` port). A provider that
 * is not ready, or that fails, answers `success: false`; `retryable` only for
 * a transient failure the provider did not act on, or one it can dedupe.
 */
export async function sendAppPush(appProviders: AppProviders | undefined, providerId: string, input: PushSendInput): Promise<AppPushResult> {
  const choice = await resolveAppProvider(appProviders, "push", providerId);
  if (!choice.provider) return { success: false, rawStatus: choice.issue.slice(0, 300), retryable: false };
  try {
    const answer = await choice.provider.send(input, {});
    return {
      success: answer.success,
      ...(answer.providerRef ? { providerRef: answer.providerRef } : {}),
      ...(answer.rawStatus ? { rawStatus: answer.rawStatus } : {}),
      ...(answer.retryable === undefined ? {} : { retryable: answer.retryable }),
    };
  } catch (error) {
    const failure = providerErrorOf(error);
    return {
      success: false,
      rawStatus: (failure?.message ?? "The push provider could not send.").slice(0, 300),
      retryable: failure?.category === "retryable" && (!failure.uncertain || input.clientReference !== undefined),
    };
  }
}

/**
 * The delivery port for one buyer (an app's `ctx.messaging.pushCustomer`,
 * any core sender): the store's choice of push provider, Web Push by
 * default. Answers whether any browser (Web Push) or the app took it.
 */
export async function sendCustomerPush(
  db: Database,
  env: { SCALIUS_SECRET?: unknown; BETTER_AUTH_URL?: unknown; STOREFRONT_URL?: unknown },
  appProviders: AppProviders | undefined,
  input: { customerId: string; notification: PushNotification; clientReference?: string },
): Promise<{ delivered: boolean }> {
  const { pushProvider } = await notificationsDocument.read(db);
  if (isQualifiedProviderId(pushProvider)) {
    const result = await sendAppPush(appProviders, pushProvider, {
      audience: "customer",
      recipients: [input.customerId],
      notification: input.notification,
      ...(input.clientReference ? { clientReference: input.clientReference } : {}),
    });
    return { delivered: result.success };
  }
  const sender = await webPushSender(env);
  if (!sender) return { delivered: false };
  const result = await sendWebPushNotification(db, sender, { audience: "customer", customerIds: [input.customerId] }, input.notification);
  return { delivered: result.sent > 0 };
}
