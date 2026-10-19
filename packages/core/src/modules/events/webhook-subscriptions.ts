// Webhook subscriptions (COMMERCE-HOOKS H3): merchant endpoints that receive
// signed event deliveries. The signing secret is generated here, shown once,
// and stored only as AES-GCM ciphertext under CREDENTIAL_ENCRYPTION_KEY.
// `customerData` (H5) lists the protected customer data categories an
// endpoint's deliveries carry; the rest read null. None by default.

import type { Database } from "@scalius/database/client";
import {
  webhookSubscriptions,
  type WebhookSubscription,
  type WebhookDisabledReason,
} from "@scalius/database/schema";
import {
  EVENTS_API_VERSION,
  WEBHOOK_SECRET_PREFIX,
  normalizeEventTopicFilters,
  type EventTopicFilter,
} from "@scalius/shared/events";
import { checkOutboundUrl, describeOutboundUrlIssue } from "@scalius/shared/outbound-url";
import {
  PROTECTED_CUSTOMER_DATA,
  isProtectedCustomerData,
  type ProtectedCustomerData,
} from "@scalius/shared/plugins/protected-data";
import { and, asc, eq, sql } from "drizzle-orm";
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { AppError, ConflictError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../errors";
import { encodeEncryptedCredential, encryptCredentials, readStoredCredentialStrict } from "../../utils/credential-encryption";

export const WEBHOOK_VERSION_CONFLICT = "WEBHOOK_VERSION_CONFLICT";

/** A webhook edit raced another: 409 with the versions so the dashboard can rebase. */
export class WebhookVersionConflictError extends AppError {
  constructor(webhookId: string, expectedVersion: number, currentVersion: number | null) {
    super(
      409,
      WEBHOOK_VERSION_CONFLICT,
      "This webhook changed since you opened it. Reload it and try again.",
      { webhookId, expectedVersion, currentVersion },
    );
    this.name = "WebhookVersionConflictError";
  }
}

/** Endpoints per store: keeps every event's fan-out one small batch. */
export const MAX_WEBHOOK_SUBSCRIPTIONS = 20;
export const WEBHOOK_DESCRIPTION_MAX_LENGTH = 200;

export interface WebhookSubscriptionView {
  id: string;
  url: string;
  topics: EventTopicFilter[];
  apiVersion: string;
  /** The protected customer data its deliveries include (`name`, `email`, `phone`, `address`). */
  customerData: ProtectedCustomerData[];
  description: string | null;
  status: "active" | "disabled";
  disabledReason: WebhookDisabledReason | null;
  disabledAt: number | null;
  failureStreak: number;
  failingSince: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  secretHint: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export function parseStoredTopicFilters(value: string): EventTopicFilter[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? normalizeEventTopicFilters(parsed.filter((item) => typeof item === "string")) ?? [] : [];
  } catch {
    return [];
  }
}

/** A stored category list, catalog order; anything unreadable reads as none (fail closed). */
export function parseStoredCustomerData(value: string | null | undefined): ProtectedCustomerData[] {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return PROTECTED_CUSTOMER_DATA.filter((category) => parsed.includes(category));
  } catch {
    return [];
  }
}

export function validateWebhookCustomerData(values: unknown): ProtectedCustomerData[] {
  if (!Array.isArray(values) || !values.every(isProtectedCustomerData)) {
    throw new ValidationError(`Customer data is a list of ${PROTECTED_CUSTOMER_DATA.join(", ")}.`, { field: "customerData" });
  }
  return PROTECTED_CUSTOMER_DATA.filter((category) => values.includes(category));
}

export function toWebhookSubscriptionView(row: WebhookSubscription): WebhookSubscriptionView {
  return {
    id: row.id,
    url: row.url,
    topics: parseStoredTopicFilters(row.topics),
    apiVersion: row.apiVersion,
    customerData: parseStoredCustomerData(row.customerData),
    description: row.description,
    status: row.status,
    disabledReason: row.disabledReason ?? null,
    disabledAt: row.disabledAt ?? null,
    failureStreak: Number(row.failureStreak),
    failingSince: row.failingSince ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastFailureAt: row.lastFailureAt ?? null,
    secretHint: row.secretHint,
    version: Number(row.version),
    createdAt: Number(row.createdAt),
    updatedAt: Number(row.updatedAt),
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `whsec_` + 32 random bytes, base64url (43 characters). */
export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

function secretHint(secret: string): string {
  return secret.slice(-4);
}

async function encryptSecret(secret: string, encryptionKey: string | undefined): Promise<string> {
  if (!encryptionKey) {
    throw new ServiceUnavailableError("CREDENTIAL_ENCRYPTION_KEY is required to store webhook signing secrets.");
  }
  return encodeEncryptedCredential(await encryptCredentials(secret, encryptionKey));
}

/** The plaintext secret for signing, or null when it cannot be read. */
export async function readWebhookSecret(
  row: Pick<WebhookSubscription, "secretCiphertext">,
  encryptionKey: string | undefined,
): Promise<string | null> {
  const read = await readStoredCredentialStrict(row.secretCiphertext, encryptionKey, "Webhook signing secret");
  // Only ciphertext is ever stored: a plaintext value is a corrupt row.
  if (read.error || !read.encrypted || !read.value.startsWith(WEBHOOK_SECRET_PREFIX)) return null;
  return read.value;
}

export function validateWebhookUrl(value: unknown): string {
  const check = checkOutboundUrl(value);
  if (!check.ok) {
    throw new ValidationError(describeOutboundUrlIssue(check.issue), { field: "url", issue: check.issue });
  }
  return check.url.toString();
}

export function validateWebhookTopics(values: unknown): EventTopicFilter[] {
  const normalized = Array.isArray(values) ? normalizeEventTopicFilters(values) : null;
  if (!normalized || normalized.length === 0) {
    throw new ValidationError("Choose at least one event from the catalog.", { field: "topics" });
  }
  return normalized;
}

function validateDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ValidationError("Description must be text.", { field: "description" });
  const trimmed = value.trim();
  if (trimmed.length > WEBHOOK_DESCRIPTION_MAX_LENGTH) {
    throw new ValidationError(`Description must be at most ${WEBHOOK_DESCRIPTION_MAX_LENGTH} characters.`, { field: "description" });
  }
  return trimmed || null;
}

function newSubscriptionId(): string {
  return `whs_${crypto.randomUUID().replace(/-/g, "")}`;
}

export async function listWebhookSubscriptions(db: Database): Promise<WebhookSubscriptionView[]> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .orderBy(asc(webhookSubscriptions.createdAt), asc(webhookSubscriptions.id))
    .limit(MAX_WEBHOOK_SUBSCRIPTIONS)
    .all();
  return rows.map(toWebhookSubscriptionView);
}

export async function getWebhookSubscription(db: Database, id: string): Promise<WebhookSubscriptionView> {
  const row = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).get();
  if (!row) throw new NotFoundError("Webhook not found");
  return toWebhookSubscriptionView(row);
}

async function assertUrlFree(db: Database, url: string, exceptId?: string): Promise<void> {
  const existing = await db
    .select({ id: webhookSubscriptions.id })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.url, url))
    .get();
  if (existing && existing.id !== exceptId) {
    throw new ConflictError("A webhook for this URL already exists. Edit it instead.");
  }
}

export async function createWebhookSubscription(
  db: Database,
  input: { url: unknown; topics: unknown; description?: unknown; customerData?: unknown },
  options: { actorId: string | null; encryptionKey: string | undefined },
): Promise<{ subscription: WebhookSubscriptionView; secret: string }> {
  const url = validateWebhookUrl(input.url);
  const topics = validateWebhookTopics(input.topics);
  const customerData = input.customerData === undefined ? [] : validateWebhookCustomerData(input.customerData);
  const description = validateDescription(input.description);
  const count = await db
    .select({ count: sql<number>`count(*)` })
    .from(webhookSubscriptions)
    .get();
  if (Number(count?.count ?? 0) >= MAX_WEBHOOK_SUBSCRIPTIONS) {
    throw new ConflictError(`A store can have at most ${MAX_WEBHOOK_SUBSCRIPTIONS} webhooks. Delete one first.`);
  }
  await assertUrlFree(db, url);

  const secret = generateWebhookSecret();
  const id = newSubscriptionId();
  const rows = await db
    .insert(webhookSubscriptions)
    .values({
      id,
      url,
      topics: JSON.stringify(topics),
      apiVersion: EVENTS_API_VERSION,
      customerData: JSON.stringify(customerData),
      description,
      secretCiphertext: await encryptSecret(secret, options.encryptionKey),
      secretHint: secretHint(secret),
      createdBy: options.actorId,
    })
    .returning();
  return { subscription: toWebhookSubscriptionView(rows[0]!), secret };
}

type SubscriptionSet = SQLiteUpdateSetSource<typeof webhookSubscriptions>;

async function updateGuarded(
  db: Database,
  id: string,
  expectedVersion: number,
  values: SubscriptionSet,
): Promise<WebhookSubscriptionView> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new ValidationError("expectedVersion must be a positive integer.", { field: "expectedVersion" });
  }
  const rows = await db
    .update(webhookSubscriptions)
    .set({ ...values, version: sql`${webhookSubscriptions.version} + 1`, updatedAt: sql`unixepoch()` })
    .where(and(eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.version, expectedVersion)))
    .returning();
  if (rows[0]) return toWebhookSubscriptionView(rows[0]);
  const current = await db
    .select({ version: webhookSubscriptions.version })
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .get();
  if (!current) throw new NotFoundError("Webhook not found");
  throw new WebhookVersionConflictError(id, expectedVersion, Number(current.version));
}

export async function updateWebhookSubscription(
  db: Database,
  id: string,
  input: {
    expectedVersion: number;
    url?: unknown;
    topics?: unknown;
    description?: unknown;
    customerData?: unknown;
    status?: "active" | "disabled";
  },
): Promise<WebhookSubscriptionView> {
  const values: SubscriptionSet = {};
  if (input.url !== undefined) {
    const url = validateWebhookUrl(input.url);
    await assertUrlFree(db, url, id);
    values.url = url;
  }
  if (input.topics !== undefined) values.topics = JSON.stringify(validateWebhookTopics(input.topics));
  if (input.description !== undefined) values.description = validateDescription(input.description);
  if (input.customerData !== undefined) values.customerData = JSON.stringify(validateWebhookCustomerData(input.customerData));
  if (input.status === "disabled") {
    Object.assign(values, {
      status: "disabled" as const,
      disabledReason: sql`COALESCE(${webhookSubscriptions.disabledReason}, 'manual')`,
      disabledAt: sql`COALESCE(${webhookSubscriptions.disabledAt}, unixepoch())`,
    });
  } else if (input.status === "active") {
    // Turning an endpoint back on starts a fresh health record.
    Object.assign(values, {
      status: "active" as const,
      disabledReason: null,
      disabledAt: null,
      failureStreak: 0,
      failingSince: null,
    });
  }
  return updateGuarded(db, id, input.expectedVersion, values);
}

export async function rotateWebhookSecret(
  db: Database,
  id: string,
  options: { encryptionKey: string | undefined },
): Promise<{ subscription: WebhookSubscriptionView; secret: string }> {
  const secret = generateWebhookSecret();
  const ciphertext = await encryptSecret(secret, options.encryptionKey);
  const rows = await db
    .update(webhookSubscriptions)
    .set({
      secretCiphertext: ciphertext,
      secretHint: secretHint(secret),
      version: sql`${webhookSubscriptions.version} + 1`,
      updatedAt: sql`unixepoch()`,
    })
    .where(eq(webhookSubscriptions.id, id))
    .returning();
  if (!rows[0]) throw new NotFoundError("Webhook not found");
  return { subscription: toWebhookSubscriptionView(rows[0]), secret };
}

export async function deleteWebhookSubscription(db: Database, id: string): Promise<void> {
  const rows = await db
    .delete(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .returning({ id: webhookSubscriptions.id });
  if (rows.length === 0) throw new NotFoundError("Webhook not found");
}
