// Customer import. A customer is matched by phone (the identity in
// Bangladesh; an account that proved the phone wins over a guest record),
// then by e-mail. A row whose e-mail belongs to a customer with another
// phone is refused rather than merged into the wrong person.
//
// Modes:
// - create: new customers only; a matched customer is skipped.
// - upsert: also fills what a matched customer is missing (a name that is
//   still just the phone, an e-mail, an empty address book) and adds tags. It never
//   overwrites what the customer already has and never removes anything.
//
// Marketing consent is recorded only for a channel the file says yes to,
// with source `import`, the importing staff member as actor, and the file's
// own wording as the note (the consent module's audit trigger keeps it). A
// "no" or a blank is never turned into an unsubscribe, so an import cannot
// undo a consent the buyer gave in the store.
//
// All writes of a request go to D1 as one batch; if that batch fails, each
// customer is written on its own so one bad row cannot sink the others.

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
import { CUSTOMER_ADDRESS_ID_PREFIX, customerAddresses, customerHistory, customerTagLinks, customers, firstCustomerAddressId } from "@scalius/database/schema";
import { and, isNull, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { validateAndFormatPhone } from "@scalius/shared/customer-utils";
import { CUSTOMER_TAGS_PER_CUSTOMER_MAX, type MarketingChannel } from "@scalius/shared/customer-marketing";
import type { CustomerImportBatch, CustomerImportItem } from "@scalius/shared/store-transfer/customers";
import { getAllowedCountries } from "../settings";
import { customerAddressColumns, resolveAddressFromRows, type AddressValidationError } from "../customers";
import {
  type ConsentChange,
  enqueueConsentNotifications,
  type MarketingLinkEnv,
  prepareConsentChanges,
  type PreparedConsentChanges,
  readConsentChangeResults,
} from "../customer-marketing";
import { ImportBudget, isWorkerLimitError } from "./budget";

export type CustomerImportStatus = "created" | "updated" | "unchanged" | "skipped" | "failed" | "would_create" | "would_update" | "would_skip";

export interface CustomerImportIssue {
  code: string;
  message: string;
  field?: string;
}

export interface CustomerImportResult {
  ref: string;
  status: CustomerImportStatus;
  customerId: string | null;
  /** Channels this row subscribed (a dry run: would subscribe). */
  subscribed: MarketingChannel[];
  issues: CustomerImportIssue[];
}

export interface CustomerImportResponse {
  results: CustomerImportResult[];
  /** Items handled; send `items.slice(processed)` again when it is short. */
  processed: number;
  stoppedEarly: boolean;
}

export interface CustomerImportContext {
  actorId?: string | null;
  env: MarketingLinkEnv;
  /** Where consent confirmations would be queued (imports subscribe directly, so none are). */
  queue?: Parameters<typeof enqueueConsentNotifications>[1];
  budget?: ImportBudget;
}

type Existing = {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  /** The customer has a saved address (an import fills an empty address book only). */
  hasAddress: number;
  accountClaimedAt: unknown;
};

type PlannedWrite = {
  index: number;
  statements: unknown[];
  consent: PreparedConsentChanges | null;
  status: "created" | "updated";
};

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() ?? null;

async function readExisting(db: Database, items: readonly CustomerImportItem[]) {
  const phones = [...new Set(items.map((item) => item.phone))];
  const emails = [...new Set(items.flatMap((item) => item.email ? [item.email.toLowerCase()] : []))];
  const columns = {
    id: customers.id,
    name: customers.name,
    email: customers.email,
    phone: customers.phone,
    // Qualified: drizzle leaves a one-table select's columns bare, and a bare name binds inside the subquery first.
    hasAddress: sql<number>`EXISTS (SELECT 1 FROM customer_addresses AS imported_book WHERE imported_book.customer_id = "customers"."id")`,
    accountClaimedAt: customers.accountClaimedAt,
  };
  const [phoneRows, emailRows] = await Promise.all([
    db.select(columns).from(customers).where(and(
      sql`${customers.phone} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(phones)}))`,
      isNull(customers.deletedAt),
    )),
    emails.length === 0 ? [] : db.select(columns).from(customers).where(and(
      sql`lower(trim(${customers.email})) IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(emails)}))`,
      isNull(customers.deletedAt),
    )),
  ]);
  const byPhone = new Map<string, Existing>();
  for (const row of phoneRows) {
    const current = byPhone.get(row.phone);
    // The account that proved the phone, else the phone's guest record.
    if (!current || (!current.accountClaimedAt && row.accountClaimedAt)) byPhone.set(row.phone, row);
  }
  const byEmail = new Map<string, Existing[]>();
  for (const row of emailRows) {
    const key = lower(row.email)!;
    byEmail.set(key, [...(byEmail.get(key) ?? []), row]);
  }
  return { byPhone, byEmail };
}

function displayName(item: CustomerImportItem): string {
  const name = item.name?.trim() ?? "";
  return name.length >= 3 ? name : item.phone;
}

function consentChanges(item: CustomerImportItem, actorId: string | null, recordEmail: string | null): { changes: ConsentChange[]; skipped: CustomerImportIssue[] } {
  const note = (item.consentEvidence ?? "Marked as subscribed in the imported file").slice(0, 500);
  const author = { source: "import" as const, actor: "staff" as const, actorId, note };
  const changes: ConsentChange[] = [];
  const skipped: CustomerImportIssue[] = [];
  if (item.marketing.email) {
    if (recordEmail && item.email && lower(recordEmail) === lower(item.email)) {
      changes.push({ ...author, channel: "email", action: "subscribe", contact: item.email.toLowerCase() });
    } else {
      skipped.push({ code: "email_consent_skipped", message: "Email marketing was not recorded: the customer's saved email is different from the file's.", field: "email" });
    }
  }
  if (item.marketing.sms) changes.push({ ...author, channel: "sms", action: "subscribe", contact: item.phone });
  if (item.marketing.whatsapp) changes.push({ ...author, channel: "whatsapp", action: "subscribe", contact: item.phone });
  return { changes, skipped };
}

/**
 * The default-address insert of an imported address. A file has no
 * Bangladesh City/Thana ids, so an address that breaks its country's rules is
 * kept, marked validation_skipped; a missing country is Bangladesh's.
 */
function importedAddressStatement(
  db: Database,
  customerId: string,
  address: CustomerImportItem["address"],
  options: { newRecord: boolean },
) {
  if (!address) return null;
  let resolved;
  try {
    resolved = resolveAddressFromRows(address, [], { skipValidation: true });
  } catch (error) {
    // Only a value too long for its field (or an unknown country) is refused outright: leave the address out.
    if ((error as AddressValidationError).issues) return null;
    throw error;
  }
  return db.insert(customerAddresses).values({
    // A new record's address is part of its creation; an existing record's is an update.
    id: options.newRecord ? firstCustomerAddressId(customerId) : `${CUSTOMER_ADDRESS_ID_PREFIX}${nanoid()}`,
    customerId,
    isDefault: true,
    ...customerAddressColumns(resolved),
    createdAt: sql`unixepoch()`,
    updatedAt: sql`unixepoch()`,
  });
}

/** Adds tags (never removes), keeping the customer within the per-customer limit. */
function tagStatement(db: Database, customerId: string, tags: readonly string[]) {
  const tagsJson = JSON.stringify(tags);
  return db.insert(customerTagLinks).select(db.select({
    customerId: sql<string>`${customerId}`.as("customer_id"),
    tag: sql<string>`tag_list.value`.as("tag"),
    createdAt: sql<number>`unixepoch()`.as("created_at"),
  }).from(sql`json_each(${tagsJson}) AS tag_list`).where(sql`(
      SELECT count(*) FROM ${customerTagLinks} AS existing WHERE existing.customer_id = ${customerId}
    ) + ${tags.length} <= ${CUSTOMER_TAGS_PER_CUSTOMER_MAX}`)).onConflictDoNothing();
}

/** Applies (or dry-runs) one batch of customers. */
export async function importCustomers(
  db: Database,
  batch: CustomerImportBatch,
  context: CustomerImportContext,
): Promise<CustomerImportResponse> {
  const budget = context.budget ?? new ImportBudget();
  const actorId = context.actorId ?? null;
  const [existing, countries] = await Promise.all([readExisting(db, batch.items), getAllowedCountries(db)]);
  const results: CustomerImportResult[] = [];
  const writes: PlannedWrite[] = [];
  let stoppedEarly = false;

  for (const [index, item] of batch.items.entries()) {
    if (budget.exhausted()) {
      stoppedEarly = true;
      break;
    }
    const result: CustomerImportResult = { ref: item.ref, status: "failed", customerId: null, subscribed: [], issues: [] };
    results.push(result);
    try {
      validateAndFormatPhone(item.phone, { countries: countries.allowedCountries, mode: countries.allowedCountriesMode });
    } catch (error) {
      result.issues.push({ code: "phone_not_accepted", message: error instanceof Error ? error.message : "This phone number is not accepted.", field: "phone" });
      continue;
    }
    const match = existing.byPhone.get(item.phone);
    const emailOwners = item.email ? existing.byEmail.get(item.email.toLowerCase()) ?? [] : [];
    const emailConflict = emailOwners.find((owner) => owner.phone !== item.phone);
    if (!match && emailConflict) {
      result.status = batch.dryRun ? "would_skip" : "skipped";
      result.customerId = emailConflict.id;
      result.issues.push({ code: "email_belongs_to_other_phone", message: `This email belongs to a customer with another phone (${emailConflict.phone}).`, field: "email" });
      continue;
    }

    if (match) {
      result.customerId = match.id;
      if (batch.mode === "create") {
        result.status = batch.dryRun ? "would_skip" : "skipped";
        result.issues.push({ code: "already_exists", message: "A customer with this phone is already in the store." });
        continue;
      }
      const updates: Partial<Pick<Existing, "name" | "email">> = {};
      const name = displayName(item);
      if ((!match.name.trim() || match.name === match.phone) && name !== match.phone) updates.name = name;
      if (!match.email && item.email && !emailConflict) updates.email = item.email;
      const addressStatement = Number(match.hasAddress) === 1 ? null : importedAddressStatement(db, match.id, item.address, { newRecord: false });
      const recordEmail = updates.email ?? match.email;
      const { changes, skipped } = consentChanges(item, actorId, recordEmail);
      result.issues.push(...skipped);
      const hasChanges = Object.keys(updates).length > 0 || addressStatement !== null || item.tags.length > 0 || changes.length > 0;
      if (!hasChanges || batch.dryRun) {
        result.status = !hasChanges ? (batch.dryRun ? "would_skip" : "unchanged") : "would_update";
        result.subscribed = changes.map((change) => change.channel);
        continue;
      }
      const statements: unknown[] = [];
      if (Object.keys(updates).length > 0) {
        statements.push(db.update(customers).set({ ...updates, updatedAt: sql`unixepoch()` }).where(sql`${customers.id} = ${match.id}`));
        statements.push(db.insert(customerHistory).values({
          id: `hist_${nanoid()}`,
          customerId: match.id,
          name: updates.name ?? match.name,
          email: recordEmail,
          phone: match.phone,
          changeType: "updated",
          actor: "staff",
          actorId,
          createdAt: sql`unixepoch()`,
        }));
      }
      if (addressStatement) statements.push(addressStatement);
      if (item.tags.length > 0) statements.push(tagStatement(db, match.id, item.tags));
      const consent = changes.length > 0
        ? await prepareConsentChanges(db, { customerId: match.id, changes, env: context.env, offset: statements.length })
        : null;
      if (consent) statements.push(...consent.statements);
      writes.push({ index, statements, consent, status: "updated" });
      continue;
    }

    // A new customer.
    const { changes, skipped } = consentChanges(item, actorId, item.email);
    result.issues.push(...skipped);
    if (batch.dryRun) {
      result.status = "would_create";
      result.subscribed = changes.map((change) => change.channel);
      continue;
    }
    const customerId = `cust_${nanoid()}`;
    result.customerId = customerId;
    const name = displayName(item);
    const statements: unknown[] = [
      db.insert(customers).values({
        id: customerId,
        name,
        email: item.email,
        phone: item.phone,
        origin: "merchant",
        totalOrders: 0,
        createdAt: sql`unixepoch()`,
        updatedAt: sql`unixepoch()`,
      }),
      db.insert(customerHistory).values({
        id: `hist_${nanoid()}`,
        customerId,
        name,
        email: item.email,
        phone: item.phone,
        changeType: "created",
        actor: "staff",
        actorId,
        createdAt: sql`unixepoch()`,
      }),
    ];
    const addressStatement = importedAddressStatement(db, customerId, item.address, { newRecord: true });
    if (addressStatement) statements.push(addressStatement);
    if (item.tags.length > 0) statements.push(tagStatement(db, customerId, item.tags));
    const consent = changes.length > 0
      ? await prepareConsentChanges(db, { customerId, changes, env: context.env, offset: statements.length })
      : null;
    if (consent) statements.push(...consent.statements);
    writes.push({ index, statements, consent, status: "created" });
  }

  const commit = async (planned: readonly PlannedWrite[]) => {
    const outcome = await safeBatch(db, planned.flatMap((write) => write.statements) as Parameters<typeof safeBatch>[1]) as unknown[];
    let offset = 0;
    for (const write of planned) {
      const result = results[write.index]!;
      result.status = write.status;
      if (write.consent) {
        result.subscribed = readConsentChangeResults(write.consent, outcome.slice(offset, offset + write.statements.length))
          .filter((change) => change.changed)
          .map((change) => change.channel);
        await enqueueConsentNotifications(db, context.queue, write.consent.outboxIds);
      }
      offset += write.statements.length;
    }
  };
  const handBack = (fromIndex: number): CustomerImportResponse => {
    results.splice(fromIndex);
    return { results, processed: results.length, stoppedEarly: true };
  };
  if (writes.length > 0) {
    try {
      await commit(writes);
    } catch (error) {
      // Nothing of the batch committed. Out of queries: hand the writes back.
      if (isWorkerLimitError(error)) return handBack(writes[0]!.index);
      for (const write of writes) {
        try {
          await commit([write]);
        } catch (single) {
          if (isWorkerLimitError(single)) return handBack(write.index);
          const result = results[write.index]!;
          const message = single instanceof Error ? single.message : String(single);
          result.status = "failed";
          if (write.status === "created") result.customerId = null;
          result.issues.push({
            code: "write_failed",
            message: /customers_(guest_phone|verified_phone|verified_email)/i.test(message)
              ? "Another customer with this phone or email was saved at the same time. Import the file again."
              : "The customer could not be saved.",
          });
        }
      }
    }
  }
  return { results, processed: results.length, stoppedEarly };
}
