// The saved setup and the open payments of the retired built-in gateways
// (SSLCommerz), for the handoff to the app that replaced them
// (apps/api/src/plugins/provider-handoff.ts, retired-providers.ts). Read
// strictly; rewritten only while each document is still the one that was
// read. Nothing here logs or returns more than field names: the values go
// straight into the app's sealed settings.

import { and, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orderPayments, orders, paymentSessionAttempts } from "@scalius/database/schema";
import { RETIRED_PAYMENT_PROVIDERS } from "../../integrations/retired-providers";
import { paymentMethodsDocument, sslcommerzDocument } from "../settings";
import { writeSettingsDocuments } from "../../settings-store";

/** One retired gateway's saved setup, read strictly. */
export interface RetiredPaymentSettings {
  /** The retired id (`sslcommerz`). */
  id: string;
  /** The app's setting keys → the saved values, in the app's terms; empty values left out. */
  values: Record<string, string>;
  /** App setting keys whose saved value could not be opened. */
  unreadable: string[];
  /** The merchant had the gateway turned on (it took payments when its keys were complete). */
  enabled: boolean;
  /** The document revision read: it is cleared only while unchanged. */
  revision: number;
  /** A document holding a setup was saved (and not yet cleared by a handoff). */
  stored: boolean;
}

/** The SSLCommerz document's fields in the Bangladesh pack's terms (`sandbox` → its environment select). */
export async function readRetiredPaymentSettings(db: Database, encryptionKey: string): Promise<RetiredPaymentSettings[]> {
  const retired = RETIRED_PAYMENT_PROVIDERS.sslcommerz;
  if (!retired) return [];
  const read = await sslcommerzDocument.readDetailed(db, { encryptionKey }, { skipCache: true });
  const keys = retired.settings;
  const values: Record<string, string> = {};
  const unreadable: string[] = [];
  // A document the handoff already cleared (no keys, off) holds nothing to move.
  const holdsSetup = read.stored && !read.invalid && (
    Boolean(read.value.storeId.trim() || read.value.storePassword.trim() || read.secretErrors.storePassword) || read.value.enabled
  );
  if (holdsSetup) {
    const storeId = read.value.storeId.trim();
    if (storeId) values[keys.storeId!] = storeId;
    if (read.secretErrors.storePassword) unreadable.push(keys.storePassword!);
    else if (read.value.storePassword.trim()) values[keys.storePassword!] = read.value.storePassword.trim();
    values[keys.sandbox!] = read.value.sandbox ? "sandbox" : "live";
  }
  return [{
    id: "sslcommerz",
    values,
    unreadable,
    enabled: holdsSetup && read.value.enabled,
    revision: read.revision,
    stored: holdsSetup,
  }];
}

/**
 * Repoints the checkout's saved choice at the app's gateway and clears the
 * old document in one batch, both compare-and-swapped on what was read: a
 * gateway the merchant had on is replaced in place (its position and the
 * default kept); one that was off is dropped, so checkout offers exactly
 * what it offered before. The old document keeps its fields while any of
 * them could not be moved (the merchant enters them again, or activates
 * again after fixing the key). False when there was nothing to change.
 */
export async function repointRetiredPaymentChoice(
  db: Database,
  read: RetiredPaymentSettings,
  options: { clearDocument: boolean },
): Promise<boolean> {
  const replacement = RETIRED_PAYMENT_PROVIDERS[read.id]!.replacement;
  const methods = await paymentMethodsDocument.readDetailed(db, {}, { skipCache: true });
  const selected = methods.value.enabledMethods;
  const writes = [];
  if (selected?.includes(read.id) || methods.value.defaultMethod === read.id) {
    const enabledMethods = selected === null ? null : [...new Set(selected.flatMap((method) => {
      if (method !== read.id) return [method];
      return read.enabled ? [replacement] : [];
    }))];
    const defaultMethod = methods.value.defaultMethod === read.id
      ? (read.enabled ? replacement : enabledMethods?.[0] ?? "cod")
      : methods.value.defaultMethod;
    writes.push({ document: paymentMethodsDocument, patch: { enabledMethods, defaultMethod }, expectedRevision: methods.revision });
  }
  if (options.clearDocument && read.stored) {
    writes.push({
      document: sslcommerzDocument,
      patch: { storeId: "", storePassword: "", sandbox: true, enabled: false },
      expectedRevision: read.revision,
      replace: true,
    });
  }
  if (writes.length === 0) return false;
  await writeSettingsDocuments(db, writes);
  return true;
}

/**
 * Repoints the payments still under way (an unpaid, part-paid or failed
 * order that may yet take a payment), with their session attempts and
 * payment rows, at the app's gateway. Settled orders keep the old id: their
 * refunds and names resolve through the registry, and rewriting a settled
 * order's method would report every one of them as changed. An open
 * checkout (`incomplete`) is rewritten without a domain event. One batch per
 * gateway; a second run changes nothing.
 */
export async function repointRetiredPaymentRows(db: Database, retiredId: string): Promise<void> {
  const replacement = RETIRED_PAYMENT_PROVIDERS[retiredId]?.replacement;
  if (!replacement) return;
  const open = and(
    eq(orders.paymentMethod, retiredId),
    isNull(orders.deletedAt),
    inArray(orders.paymentStatus, ["unpaid", "partial", "failed"]),
    notInArray(orders.status, ["cancelled", "refunded", "returned"]),
  );
  const openOrderIds = db.select({ id: orders.id }).from(orders).where(open);
  await db.batch([
    db.update(paymentSessionAttempts)
      .set({ gateway: replacement, updatedAt: sql`unixepoch()` })
      .where(and(eq(paymentSessionAttempts.gateway, retiredId), inArray(paymentSessionAttempts.orderId, openOrderIds))),
    db.update(orderPayments)
      .set({ paymentMethod: replacement, updatedAt: sql`unixepoch()` })
      .where(and(
        eq(orderPayments.paymentMethod, retiredId),
        ne(orderPayments.paymentType, "refund"),
        inArray(orderPayments.orderId, openOrderIds),
      )),
    db.update(orders).set({ paymentMethod: replacement }).where(open),
  ]);
}
