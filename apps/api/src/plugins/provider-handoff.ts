// Retired built-in providers handed to the app that replaced them
// (docs/platform/PLUGINS.md, "Retired built-in providers"). When a Super
// Admin activates that app, the store's old configuration of those providers
// moves into the app's settings, so a store keeps sending, checking and
// shipping with the keys it saved before the move:
//
//   1. Read the old configuration with the strict reader
//      (CREDENTIAL_ENCRYPTION_KEY): the `sms` document's gateway fields, the
//      `fraud-checker` rows, the `delivery_providers` rows of a retired
//      type (a courier's active row, else its newest) and a retired payment
//      gateway's document (`sslcommerz`). A value this key cannot open is
//      skipped and reported, never guessed.
//   2. Write it into the app's settings (secrets sealed for the app), only
//      into keys the merchant has not set there: the app's own settings win.
//      A value the app's settings refuse (not https, a placeholder) is
//      skipped and reported.
//   3. Repoint the saved choices at the app's providers and drop the moved
//      fields: the `sms` document is replaced (compare-and-swap on the
//      revision read), each fraud and delivery row is rewritten only while it
//      is still the row that was read, and the retired couriers' shipments
//      name the app's couriers (their tracking pages saved). A retired
//      payment gateway the merchant had on is replaced in the checkout's
//      payment methods (one that was off is dropped), its document is
//      cleared once every field moved, and its payments still under way
//      (unpaid, part-paid or failed orders, their attempts and payment rows)
//      name the app's gateway. Settled orders keep the old id, which the
//      payment registry resolves to the app's gateway.
//
// Idempotent: a second activation finds nothing left to move. Nothing here
// logs or returns a credential; the result names setting keys only.

import type { Database } from "@scalius/database/client";
import { readRetiredFraudCheckers, replaceRetiredFraudChecker, type RetiredFraudChecker } from "@scalius/core/modules/fraud-checker";
import {
  readRetiredCourierRows,
  repointRetiredCourierRow,
  repointRetiredCourierShipments,
  type RetiredCourierRow,
} from "@scalius/core/modules/delivery";
import {
  PluginError,
  isSealedPluginSecret,
  requirePluginInstallation,
  writePluginSettings,
  type PluginInstallation,
} from "@scalius/core/modules/plugins";
import { smsDocument } from "@scalius/core/modules/settings";
import { selectSettingsDocuments } from "@scalius/core/settings-store";
import {
  readRetiredPaymentSettings,
  repointRetiredPaymentChoice,
  repointRetiredPaymentRows,
  type RetiredPaymentSettings,
} from "@scalius/core/modules/payments";
import {
  RETIRED_COURIER_PROVIDERS,
  RETIRED_FRAUD_PROVIDERS,
  RETIRED_PAYMENT_PROVIDERS,
  RETIRED_SMS_PROVIDERS,
  RETIRED_SMS_SECRET_FIELDS,
  type RetiredProvider,
} from "@scalius/core/integrations/retired-providers";
import { readStoredCredentialStrict } from "@scalius/core/utils/credential-encryption";
import { parseQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";

export interface ProviderHandoffResult {
  /** App setting keys that received a saved value. */
  moved: string[];
  /** App setting keys whose old value could not be moved: the merchant enters them again. */
  skipped: string[];
  /** Saved choices now pointing at the app (`sms`, fraud row ids, delivery provider row ids). */
  repointed: string[];
}

const EMPTY: ProviderHandoffResult = { moved: [], skipped: [], repointed: [] };

/** The retired providers this app replaced, by old id. */
function replacedBy(installation: PluginInstallation, table: Readonly<Record<string, RetiredProvider>>): Array<[string, RetiredProvider]> {
  return Object.entries(table).filter(([, retired]) => {
    const target = parseQualifiedProviderId(retired.replacement);
    return target?.pluginId === installation.pluginId
      && installation.manifest.providers.some((provider) => provider.id === target.providerId);
  });
}

function isSet(installation: PluginInstallation, key: string): boolean {
  const stored = installation.storedSettings[key];
  return isSealedPluginSecret(stored) || (stored !== undefined && stored !== null && stored !== "");
}

/** The `sms` document's old gateway fields, decrypted, by the app setting they move to. */
async function smsCandidates(
  db: Database,
  retired: Array<[string, RetiredProvider]>,
  encryptionKey: string,
): Promise<{ document: Record<string, unknown> | null; revision: number; values: Map<string, { field: string; value: string }>; unreadable: string[] }> {
  const [row] = await selectSettingsDocuments(db, [smsDocument]);
  const values = new Map<string, { field: string; value: string }>();
  const unreadable: string[] = [];
  if (!row) return { document: null, revision: 0, values, unreadable };
  let document: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(row.value) as unknown;
    document = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    document = null;
  }
  if (!document) return { document: null, revision: row.revision, values, unreadable };
  for (const [, provider] of retired) {
    for (const [field, target] of Object.entries(provider.settings)) {
      const raw = document[field];
      if (typeof raw !== "string" || !raw.trim()) continue;
      if (!RETIRED_SMS_SECRET_FIELDS.includes(field)) {
        values.set(target, { field, value: raw.trim() });
        continue;
      }
      const read = await readStoredCredentialStrict(raw, encryptionKey, field);
      if (read.error || !read.value.trim()) unreadable.push(target);
      else values.set(target, { field, value: read.value.trim() });
    }
  }
  return { document, revision: row.revision, values, unreadable };
}

type Candidate = { field: string; value: unknown };

/** A saved value in the type the app's setting takes (a number field gets a number, a select its option). */
function settingValue(installation: PluginInstallation, key: string, value: string | number): unknown {
  const field = installation.manifest.settings.find((candidate) => candidate.key === key);
  if (field?.type === "number") return typeof value === "number" ? value : Number(value);
  return String(value);
}

/** Each retired courier's values from its active row, else its newest one; the old fields that could not be opened. */
function courierCandidates(installation: PluginInstallation, rows: RetiredCourierRow[]): { values: Map<string, Candidate>; unreadable: string[] } {
  const values = new Map<string, Candidate>();
  const unreadable: string[] = [];
  const byType = new Map<string, RetiredCourierRow>();
  for (const row of rows) {
    const chosen = byType.get(row.type);
    if (!chosen || (!chosen.isActive && row.isActive) || (chosen.isActive === row.isActive && row.updatedAt > chosen.updatedAt)) byType.set(row.type, row);
  }
  for (const [type, row] of byType) {
    const settings = RETIRED_COURIER_PROVIDERS[type]!.settings;
    for (const [field, value] of Object.entries(row.values)) {
      const target = settings[field];
      if (target) values.set(target, { field, value: settingValue(installation, target, value) });
    }
    for (const field of row.unreadable) {
      const target = settings[field];
      if (target) unreadable.push(target);
    }
  }
  return { values, unreadable };
}

/** Each retired fraud type's values from its active row, else its newest one. */
function fraudCandidates(rows: RetiredFraudChecker[]): Map<string, Candidate> {
  const values = new Map<string, Candidate>();
  const byType = new Map<string, RetiredFraudChecker>();
  for (const row of rows) {
    const chosen = byType.get(row.type);
    if (!chosen || (!chosen.isActive && row.isActive)) byType.set(row.type, row);
  }
  for (const [type, row] of byType) {
    for (const [field, target] of Object.entries(RETIRED_FRAUD_PROVIDERS[type]!.settings)) {
      const value = row.values[field];
      if (value) values.set(target, { field, value });
    }
  }
  return values;
}

/** Each retired payment gateway's saved setup, already in the app's setting terms. */
function paymentCandidates(reads: RetiredPaymentSettings[]): { values: Map<string, Candidate>; unreadable: string[] } {
  const values = new Map<string, Candidate>();
  const unreadable: string[] = [];
  for (const read of reads) {
    for (const [key, value] of Object.entries(read.values)) values.set(key, { field: key, value });
    unreadable.push(...read.unreadable);
  }
  return { values, unreadable };
}

/**
 * Writes `candidates` into the app's unset settings. A value the app's schema
 * refuses is dropped and the write retried, so one bad old value never blocks
 * the others.
 */
async function writeCandidates(
  db: Database,
  pluginId: string,
  candidates: Map<string, Candidate>,
  encryptionKey: string,
): Promise<{ moved: string[]; skipped: string[] }> {
  const skipped: string[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const installation = await requirePluginInstallation(db, pluginId);
    const schema = installation.manifest.settings;
    const pending = [...candidates.keys()].filter((key) => schema.some((field) => field.key === key) && !isSet(installation, key));
    if (pending.length === 0) return { moved: [], skipped };
    const values: Record<string, unknown> = {};
    for (const field of schema) {
      if (pending.includes(field.key)) values[field.key] = candidates.get(field.key)!.value;
      else if (field.type !== "secret" && installation.storedSettings[field.key] !== undefined) values[field.key] = installation.storedSettings[field.key];
    }
    try {
      await writePluginSettings(db, pluginId, values, { expectedRevision: installation.revision, credentialEncryptionKey: encryptionKey });
      return { moved: pending, skipped };
    } catch (error) {
      if (!(error instanceof PluginError)) throw error;
      if (error.pluginCode === "installation.revision_conflict") continue;
      const refused = ((error.details as { errors?: Array<{ key: string }> } | undefined)?.errors ?? [])
        .map((entry) => entry.key)
        .filter((key) => pending.includes(key));
      if (refused.length === 0) throw error;
      for (const key of refused) {
        candidates.delete(key);
        skipped.push(key);
      }
    }
  }
  return { moved: [], skipped };
}

/**
 * Moves the store's configuration of the retired built-in providers this app
 * replaced into its settings and repoints the saved choices. Runs when the
 * app is activated; a store with nothing to move reads two rows.
 */
export async function handOffRetiredProviders(
  db: Database,
  pluginId: string,
  encryptionKey: string | undefined,
): Promise<ProviderHandoffResult> {
  const installation = await requirePluginInstallation(db, pluginId);
  const sms = replacedBy(installation, RETIRED_SMS_PROVIDERS);
  const fraud = replacedBy(installation, RETIRED_FRAUD_PROVIDERS);
  const couriers = replacedBy(installation, RETIRED_COURIER_PROVIDERS);
  const payments = replacedBy(installation, RETIRED_PAYMENT_PROVIDERS);
  if ((sms.length === 0 && fraud.length === 0 && couriers.length === 0 && payments.length === 0) || !encryptionKey) return EMPTY;

  const smsRead = sms.length > 0 ? await smsCandidates(db, sms, encryptionKey) : null;
  const fraudTypes = new Set(fraud.map(([type]) => type));
  const fraudRows = fraud.length > 0 ? (await readRetiredFraudCheckers(db, encryptionKey)).filter((row) => fraudTypes.has(row.type)) : [];

  const courierTypes = new Set(couriers.map(([type]) => type));
  const courierRows = courierTypes.size > 0 ? (await readRetiredCourierRows(db, encryptionKey)).filter((row) => courierTypes.has(row.type)) : [];
  const courierRead = courierCandidates(installation, courierRows);

  const paymentIds = new Set(payments.map(([id]) => id));
  const paymentReads = paymentIds.size > 0 ? (await readRetiredPaymentSettings(db, encryptionKey)).filter((read) => paymentIds.has(read.id)) : [];
  const paymentRead = paymentCandidates(paymentReads);

  const candidates = new Map<string, Candidate>([
    ...(smsRead?.values ?? []),
    ...fraudCandidates(fraudRows),
    ...courierRead.values,
    ...paymentRead.values,
  ]);
  const written = await writeCandidates(db, pluginId, candidates, encryptionKey);
  const result: ProviderHandoffResult = {
    moved: written.moved,
    skipped: [...new Set([...(smsRead?.unreadable ?? []), ...courierRead.unreadable, ...paymentRead.unreadable, ...written.skipped])],
    repointed: [],
  };

  // The saved SMS choice now names the app; the moved and empty old fields go.
  if (smsRead?.document) {
    const document = { ...smsRead.document };
    const movedFields = new Set([...candidates.values()].map((candidate) => candidate.field));
    let changed = false;
    for (const [, provider] of sms) {
      for (const field of Object.keys(provider.settings)) {
        if (!(field in document)) continue;
        const raw = document[field];
        if (movedFields.has(field) || typeof raw !== "string" || !raw.trim()) {
          delete document[field];
          changed = true;
        }
      }
    }
    const active = typeof document.activeProvider === "string" ? document.activeProvider : "";
    const replacement = sms.find(([id]) => id === active)?.[1].replacement;
    if (replacement) {
      document.activeProvider = replacement;
      changed = true;
      result.repointed.push("sms");
    }
    if (changed) {
      await smsDocument.write(db, document as { activeProvider: string }, {}, { expectedRevision: smsRead.revision, replace: true });
    }
  }

  for (const row of fraudRows) {
    if (await replaceRetiredFraudChecker(db, row, encryptionKey)) result.repointed.push(row.id);
  }
  // Delivery rows, then their shipments (kept readable: their tracking pages are saved now).
  for (const row of courierRows) {
    if (await repointRetiredCourierRow(db, row)) result.repointed.push(row.id);
  }
  for (const type of courierTypes) await repointRetiredCourierShipments(db, type);
  // Payment gateways: the checkout's choice (and, once every field moved,
  // the old document), then the payments still under way.
  for (const read of paymentReads) {
    const keys = Object.values(RETIRED_PAYMENT_PROVIDERS[read.id]!.settings);
    const allMoved = !keys.some((key) => result.skipped.includes(key));
    if (await repointRetiredPaymentChoice(db, read, { clearDocument: allMoved })) result.repointed.push(`payment_methods:${read.id}`);
    await repointRetiredPaymentRows(db, read.id);
  }
  if (result.moved.length > 0 || result.skipped.length > 0 || result.repointed.length > 0) {
    // Setting keys and counts only.
    console.info(`[plugins] ${pluginId} took over retired providers: ${result.moved.length} settings moved, ${result.skipped.length} skipped, ${result.repointed.length} choices repointed`);
  }
  return result;
}
