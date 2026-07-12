import { and, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";

import { safeBatch, type Database } from "@scalius/database/client";
import {
  invoiceIssueCommands,
  invoiceSequences,
  orderInvoices,
  orders,
} from "@scalius/database/schema";
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
} from "@scalius/core/errors";
import { getBusinessSettings } from "../settings/business-settings.service";
import { readInvoiceOrderSource } from "./invoice-order-reader";
import {
  INVOICE_RENDER_VERSION,
  formatInvoiceNumber,
  hashInvoiceContent,
  invoiceSnapshotToDocument,
  parseStoredInvoice,
  snapshotInvoiceOrder,
  stableInvoiceStringify,
  validateInvoiceBusinessInfo,
  type InvoiceDocument,
  type StoredInvoiceSnapshot,
} from "./invoice-snapshot";

export {
  formatInvoiceNumber,
  type InvoiceDocument,
  type InvoiceOrderItemSnapshot,
  type InvoiceOrderSnapshot,
} from "./invoice-snapshot";

const INVOICE_SEQUENCE_KEY = "default";
const ISSUE_RETRY_LIMIT = 4;

export interface IssueInvoiceInput {
  operationKey: string;
  expectedOrderVersion: number;
}

async function readIssuedByOrder(db: Database, orderId: string) {
  return db
    .select({ snapshot: orderInvoices.snapshot, contentHash: orderInvoices.contentHash })
    .from(orderInvoices)
    .where(eq(orderInvoices.orderId, orderId))
    .get();
}

async function readIssuedById(db: Database, invoiceId: string) {
  return db
    .select({ snapshot: orderInvoices.snapshot, contentHash: orderInvoices.contentHash })
    .from(orderInvoices)
    .where(eq(orderInvoices.id, invoiceId))
    .get();
}

export async function buildInvoiceIssueRequestHash(
  orderId: string,
  expectedOrderVersion: number,
): Promise<string> {
  return hashInvoiceContent(
    stableInvoiceStringify({ orderId, expectedOrderVersion }),
  );
}

async function readCommand(db: Database, operationKey: string) {
  return db
    .select({
      requestHash: invoiceIssueCommands.requestHash,
      invoiceId: invoiceIssueCommands.invoiceId,
    })
    .from(invoiceIssueCommands)
    .where(eq(invoiceIssueCommands.operationKey, operationKey))
    .get();
}

async function resolveCommandReplay(
  db: Database,
  operationKey: string,
  expectedHash: string,
): Promise<InvoiceDocument | null> {
  const command = await readCommand(db, operationKey);
  if (!command) return null;
  if (command.requestHash !== expectedHash) {
    throw new ConflictError(
      "Invoice operation key was already used for a different request.",
    );
  }
  const issued = await readIssuedById(db, command.invoiceId);
  if (!issued) {
    throw new ServiceUnavailableError("Invoice issuance evidence is incomplete.");
  }
  return parseStoredInvoice(issued);
}

function isConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("constraint failed") || message.includes("UNIQUE constraint failed");
}

async function consumeOperationForIssuedInvoice(params: {
  db: Database;
  orderId: string;
  operationKey: string;
  requestHash: string;
  actorId: string | null;
}): Promise<InvoiceDocument> {
  const issuedRow = await params.db
    .select({
      id: orderInvoices.id,
      snapshot: orderInvoices.snapshot,
      contentHash: orderInvoices.contentHash,
    })
    .from(orderInvoices)
    .where(eq(orderInvoices.orderId, params.orderId))
    .get();
  if (!issuedRow) throw new NotFoundError("Invoice not found");
  try {
    await params.db.insert(invoiceIssueCommands).values({
      id: `iic_${nanoid(20)}`,
      operationKey: params.operationKey,
      requestHash: params.requestHash,
      orderId: params.orderId,
      invoiceId: issuedRow.id,
      actorId: params.actorId,
    });
  } catch (error) {
    if (!isConstraintError(error)) throw error;
    const replay = await resolveCommandReplay(
      params.db,
      params.operationKey,
      params.requestHash,
    );
    if (replay) return replay;
    throw error;
  }
  return parseStoredInvoice(issuedRow);
}

export async function getInvoiceDocument(
  db: Database,
  orderId: string,
): Promise<InvoiceDocument | null> {
  const issued = await readIssuedByOrder(db, orderId);
  if (issued) return parseStoredInvoice(issued);

  const [order, businessInfo] = await Promise.all([
    readInvoiceOrderSource(db, orderId),
    getBusinessSettings(db),
  ]);
  if (!order) return null;
  return {
    status: "draft",
    order: snapshotInvoiceOrder(order),
    invoiceNumber: null,
    invoiceNum: null,
    businessInfo,
    issuedAt: null,
    contentHash: null,
    renderVersion: INVOICE_RENDER_VERSION,
    orderVersion: order.version,
  };
}

async function attemptIssueInvoice(params: {
  db: Database;
  orderId: string;
  input: IssueInvoiceInput;
  actorId: string | null;
  operationKey: string;
  requestHash: string;
}): Promise<InvoiceDocument | null> {
  const [order, rawBusinessInfo, sequence] = await Promise.all([
    readInvoiceOrderSource(params.db, params.orderId),
    getBusinessSettings(params.db),
    params.db
      .select({ currentValue: invoiceSequences.currentValue })
      .from(invoiceSequences)
      .where(eq(invoiceSequences.key, INVOICE_SEQUENCE_KEY))
      .get(),
  ]);
  if (!order) throw new NotFoundError("Order not found");
  if (order.deletedAt != null) {
    throw new ConflictError("Deleted orders cannot issue invoices.");
  }
  if (order.version !== params.input.expectedOrderVersion) {
    throw new ConflictError(
      "Order changed while the invoice was being prepared. Reload and try again.",
    );
  }
  if (!sequence) {
    throw new ServiceUnavailableError("Invoice number sequence is not initialized.");
  }

  const businessInfo = validateInvoiceBusinessInfo(rawBusinessInfo);
  const invoiceNumber = sequence.currentValue + 1;
  const issuedAt = Math.floor(Date.now() / 1000);
  const invoiceId = `inv_${nanoid(20)}`;
  const formattedNumber = formatInvoiceNumber(
    businessInfo.invoicePrefix,
    invoiceNumber,
  );
  const invoiceSnapshot: StoredInvoiceSnapshot = {
    schemaVersion: 1,
    renderVersion: INVOICE_RENDER_VERSION,
    invoiceNumber,
    formattedNumber,
    prefix: businessInfo.invoicePrefix,
    issuedAt,
    businessInfo,
    order: snapshotInvoiceOrder(order),
  };
  const snapshot = stableInvoiceStringify(invoiceSnapshot);
  const contentHash = await hashInvoiceContent(snapshot);
  const noExistingInvoice = sql`NOT EXISTS (
    SELECT 1 FROM ${orderInvoices}
    WHERE ${orderInvoices.orderId} = ${params.orderId}
  )`;

  const invoiceInsert = params.db.insert(orderInvoices).select(
    params.db
      .select({
        id: sql<string>`${invoiceId}`.as("id"),
        orderId: orders.id,
        invoiceNumber: sql<number>`${invoiceNumber}`.as("invoice_number"),
        prefix: sql<string>`${businessInfo.invoicePrefix}`.as("prefix"),
        formattedNumber: sql<string>`${formattedNumber}`.as("formatted_number"),
        orderVersion: orders.version,
        snapshot: sql<string>`${snapshot}`.as("snapshot"),
        contentHash: sql<string>`${contentHash}`.as("content_hash"),
        renderVersion: sql<string>`${INVOICE_RENDER_VERSION}`.as("render_version"),
        issuedBy: sql<string | null>`${params.actorId}`.as("issued_by"),
        issuedAt: sql<number>`${issuedAt}`.as("issued_at"),
        createdAt: sql<number>`${issuedAt}`.as("created_at"),
      })
      .from(orders)
      .innerJoin(invoiceSequences, eq(invoiceSequences.key, INVOICE_SEQUENCE_KEY))
      .where(and(
        eq(orders.id, params.orderId),
        eq(orders.version, params.input.expectedOrderVersion),
        eq(invoiceSequences.currentValue, sequence.currentValue),
        noExistingInvoice,
      )),
  ).returning({ id: orderInvoices.id });
  const invoiceExists = sql`EXISTS (
    SELECT 1 FROM ${orderInvoices}
    WHERE ${orderInvoices.id} = ${invoiceId}
  )`;
  const commandInsert = params.db.insert(invoiceIssueCommands).select(
    params.db
      .select({
        id: sql<string>`${`iic_${nanoid(20)}`}`.as("id"),
        operationKey: sql<string>`${params.operationKey}`.as("operation_key"),
        requestHash: sql<string>`${params.requestHash}`.as("request_hash"),
        orderId: orderInvoices.orderId,
        invoiceId: orderInvoices.id,
        actorId: sql<string | null>`${params.actorId}`.as("actor_id"),
        createdAt: sql<number>`${issuedAt}`.as("created_at"),
      })
      .from(orderInvoices)
      .where(eq(orderInvoices.id, invoiceId)),
  ).returning({ id: invoiceIssueCommands.id });
  const orderUpdate = params.db.update(orders).set({
    version: params.input.expectedOrderVersion + 1,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(orders.id, params.orderId),
    eq(orders.version, params.input.expectedOrderVersion),
    invoiceExists,
  )).returning({ id: orders.id });
  const sequenceUpdate = params.db.update(invoiceSequences).set({
    currentValue: invoiceNumber,
    updatedAt: sql`unixepoch()`,
  }).where(and(
    eq(invoiceSequences.key, INVOICE_SEQUENCE_KEY),
    eq(invoiceSequences.currentValue, sequence.currentValue),
    invoiceExists,
  )).returning({ key: invoiceSequences.key });

  try {
    const results = await safeBatch(
      params.db,
      [invoiceInsert, commandInsert, orderUpdate, sequenceUpdate] as never,
    ) as { id?: string; key?: string }[][];
    if (results.every((rows) => rows.length > 0)) {
      return invoiceSnapshotToDocument(invoiceSnapshot, contentHash);
    }
  } catch (error) {
    if (!isConstraintError(error)) throw error;
  }

  const replay = await resolveCommandReplay(
    params.db,
    params.operationKey,
    params.requestHash,
  );
  if (replay) return replay;
  const existing = await readIssuedByOrder(params.db, params.orderId);
  if (existing) {
    return consumeOperationForIssuedInvoice({
      db: params.db,
      orderId: params.orderId,
      operationKey: params.operationKey,
      requestHash: params.requestHash,
      actorId: params.actorId,
    });
  }
  return null;
}

export async function issueInvoice(
  db: Database,
  orderId: string,
  input: IssueInvoiceInput,
  actorId: string | null,
): Promise<InvoiceDocument> {
  const operationKey = input.operationKey.trim();
  if (operationKey.length < 8 || operationKey.length > 200) {
    throw new ValidationError("Invoice operation key must be between 8 and 200 characters.");
  }
  if (!Number.isInteger(input.expectedOrderVersion) || input.expectedOrderVersion < 1) {
    throw new ValidationError("Expected order version must be a positive integer.");
  }
  const expectedHash = await buildInvoiceIssueRequestHash(
    orderId,
    input.expectedOrderVersion,
  );
  const replay = await resolveCommandReplay(db, operationKey, expectedHash);
  if (replay) return replay;
  const existing = await readIssuedByOrder(db, orderId);
  if (existing) {
    return consumeOperationForIssuedInvoice({
      db,
      orderId,
      operationKey,
      requestHash: expectedHash,
      actorId,
    });
  }

  for (let attempt = 0; attempt < ISSUE_RETRY_LIMIT; attempt += 1) {
    const result = await attemptIssueInvoice({
      db,
      orderId,
      input,
      actorId,
      operationKey,
      requestHash: expectedHash,
    });
    if (result) return result;
  }
  throw new ConflictError(
    "Invoice number allocation changed concurrently. Reload and try again.",
  );
}
