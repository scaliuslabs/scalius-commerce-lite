// Retired built-in providers handed to the app that replaced them
// (docs/platform/PLUGINS.md, "Retired built-in providers"). When a Super
// Admin activates that app, the store's old configuration of those providers
// moves into the app's settings, so a store keeps sending and checking with
// the keys it saved before the move:
//
//   1. Read the old configuration with the strict reader
//      (CREDENTIAL_ENCRYPTION_KEY): the `sms` document's gateway fields and
//      the `fraud-checker` rows of a retired type. A value this key cannot
//      open is skipped and reported, never guessed.
//   2. Write it into the app's settings (secrets sealed for the app), only
//      into keys the merchant has not set there: the app's own settings win.
//      A value the app's settings refuse (not https, a placeholder) is
//      skipped and reported.
//   3. Repoint the saved choices at the app's providers and drop the moved
//      fields: the `sms` document is replaced (compare-and-swap on the
//      revision read), each fraud row is rewritten only while it is still the
//      row that was read.
//
// Idempotent: a second activation finds nothing left to move. Nothing here
// logs or returns a credential; the result names setting keys only.

import type { Database } from "@scalius/database/client";
import { readRetiredFraudCheckers, replaceRetiredFraudChecker, type RetiredFraudChecker } from "@scalius/core/modules/fraud-checker";
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
  RETIRED_FRAUD_PROVIDERS,
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
  /** Saved choices now pointing at the app (`sms`, fraud row ids). */
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

/** Each retired fraud type's values from its active row, else its newest one. */
function fraudCandidates(rows: RetiredFraudChecker[]): Map<string, { field: string; value: string }> {
  const values = new Map<string, { field: string; value: string }>();
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

/**
 * Writes `candidates` into the app's unset settings. A value the app's schema
 * refuses is dropped and the write retried, so one bad old value never blocks
 * the others.
 */
async function writeCandidates(
  db: Database,
  pluginId: string,
  candidates: Map<string, { field: string; value: string }>,
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
  if ((sms.length === 0 && fraud.length === 0) || !encryptionKey) return EMPTY;

  const smsRead = sms.length > 0 ? await smsCandidates(db, sms, encryptionKey) : null;
  const fraudTypes = new Set(fraud.map(([type]) => type));
  const fraudRows = fraud.length > 0 ? (await readRetiredFraudCheckers(db, encryptionKey)).filter((row) => fraudTypes.has(row.type)) : [];

  const candidates = new Map([...(smsRead?.values ?? []), ...fraudCandidates(fraudRows)]);
  const written = await writeCandidates(db, pluginId, candidates, encryptionKey);
  const result: ProviderHandoffResult = {
    moved: written.moved,
    skipped: [...new Set([...(smsRead?.unreadable ?? []), ...written.skipped])],
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
  if (result.moved.length > 0 || result.skipped.length > 0 || result.repointed.length > 0) {
    // Setting keys and counts only.
    console.info(`[plugins] ${pluginId} took over retired providers: ${result.moved.length} settings moved, ${result.skipped.length} skipped, ${result.repointed.length} choices repointed`);
  }
  return result;
}
