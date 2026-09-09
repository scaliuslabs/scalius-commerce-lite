import { buildBatchGuard, safeBatch, type Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import { sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import {
  encodeEncryptedCredential,
  encryptCredentials,
} from "@scalius/core/utils/credential-encryption";
import { ConflictError } from "@scalius/core/errors";
import {
  isMediaReferenceDeletingGuardError,
  MEDIA_REFERENCE_DELETING_MESSAGE,
  noDeletingMediaReferences,
} from "../media/media-reference-guard";

type SQLiteBatchItem = BatchItem<"sqlite">;

export interface SettingAggregateWrite {
  category: string;
  key: string;
  value: string;
  type?: string;
  encrypted?: boolean;
  rejectDeletingMediaReferences?: boolean;
}

/**
 * Prepares every value, including secret encryption, before constructing any
 * database statement. Callers can safely combine the result with related
 * provider-neutral batch statements.
 */
export async function prepareSettingAggregateStatements(
  db: Database,
  writes: readonly SettingAggregateWrite[],
  encryptionKey?: string,
): Promise<SQLiteBatchItem[]> {
  const identities = new Set<string>();
  for (const write of writes) {
    if (!write.category.trim() || !write.key.trim()) {
      throw new Error("Setting category and key are required.");
    }
    const identity = `${write.category}\u0000${write.key}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate setting write: ${write.category}/${write.key}`);
    }
    identities.add(identity);
  }

  if (writes.some((write) => write.encrypted) && !encryptionKey) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY is required to store provider credentials.");
  }

  const prepared = await Promise.all(writes.map(async (write) => ({
    ...write,
    value: write.encrypted
      ? encodeEncryptedCredential(await encryptCredentials(write.value, encryptionKey!))
      : write.value,
  })));

  return prepared.map((write) => db
    .insert(settings)
    .values({
      id: crypto.randomUUID(),
      key: write.key,
      value: write.value,
      type: write.type ?? "string",
      category: write.category,
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.category],
      set: { value: write.value, type: write.type ?? "string", updatedAt: sql`unixepoch()` },
    })) as SQLiteBatchItem[];
}

/** Saves one logical settings form as one relational-provider transaction. */
export async function saveSettingAggregate(
  db: Database,
  writes: readonly SettingAggregateWrite[],
  encryptionKey?: string,
): Promise<void> {
  if (writes.length === 0) return;
  const statements = await prepareSettingAggregateStatements(db, writes, encryptionKey);
  const mediaGuards = writes
    .filter((write) => write.rejectDeletingMediaReferences)
    .flatMap((write) => {
      const guard = noDeletingMediaReferences(write.value);
      return guard ? [buildBatchGuard(db, guard, "MEDIA_REFERENCE_DELETING")] : [];
    });
  try {
    await safeBatch(db, [...mediaGuards, ...statements] as never);
  } catch (error) {
    if (isMediaReferenceDeletingGuardError(error)) {
      throw new ConflictError(MEDIA_REFERENCE_DELETING_MESSAGE);
    }
    throw error;
  }
}
