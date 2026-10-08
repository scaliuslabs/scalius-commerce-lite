// Metaobjects (docs/platform/PLUGINS.md, "Metaobjects"; Shopify
// metaobjects) for the dashboard, agents and apps: revision-guarded
// definition and entry writes, values validated by the custom-field codec,
// and the storefront read the theme builder's Metaobjects section uses.
//
// Namespace guard: the merchant writes definitions in `custom`; an app's
// definitions (its own namespace) come from its manifest and only its app
// changes them (`syncAppMetaobjectDefinitions`). Entries of any definition
// are content: the merchant and any principal with `metaobjects.edit` write
// them. Deleting a definition deletes its entries.

import { metaobjectDefinitions, metaobjectEntries, type MetaobjectDefinitionRow, type MetaobjectEntryRow } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  customFieldWireValue,
  parseCustomFieldValue,
  type CustomFieldCodecContext,
} from "@scalius/shared/custom-fields";
import {
  METAOBJECT_DEFINITIONS_MAX,
  METAOBJECT_DEFINITION_ID_PREFIX,
  METAOBJECT_ENTRIES_PER_DEFINITION_MAX,
  METAOBJECT_ENTRY_ID_PREFIX,
  METAOBJECT_HANDLE_PATTERN,
  METAOBJECT_MERCHANT_NAMESPACE,
  metaobjectDefinitionInputSchema,
  metaobjectDisplayField,
  metaobjectFieldListSchema,
  metaobjectHandle,
  metaobjectHandleFrom,
  type MetaobjectDefinitionInput,
  type MetaobjectEntryStatus,
  type MetaobjectFieldDefinition,
} from "@scalius/shared/metaobjects";
import { AppError, NotFoundError, ValidationError } from "@scalius/core/errors";
import { readStoreCurrency } from "../markets";

export const METAOBJECT_REVISION_CONFLICT = "METAOBJECT_REVISION_CONFLICT";
export const METAOBJECT_TYPE_TAKEN = "METAOBJECT_TYPE_TAKEN";
export const METAOBJECT_HANDLE_TAKEN = "METAOBJECT_HANDLE_TAKEN";
export const METAOBJECT_NAMESPACE_FORBIDDEN = "METAOBJECT_NAMESPACE_FORBIDDEN";
export const METAOBJECT_LIMIT = "METAOBJECT_LIMIT";

/** Who writes: the merchant (staff, agents) or an app (its own namespace). */
export type MetaobjectWriter = { kind: "merchant" } | { kind: "plugin"; pluginId: string };
export const MERCHANT_METAOBJECT_WRITER: MetaobjectWriter = Object.freeze({ kind: "merchant" });

export class MetaobjectRevisionConflictError extends AppError {
  constructor(id: string, expectedRevision: number) {
    super(409, METAOBJECT_REVISION_CONFLICT, "This changed while you were editing. Reload it and try again.", { id, expectedRevision });
    this.name = "MetaobjectRevisionConflictError";
  }
}

export class MetaobjectNamespaceError extends AppError {
  constructor(namespace: string) {
    super(403, METAOBJECT_NAMESPACE_FORBIDDEN, namespace === METAOBJECT_MERCHANT_NAMESPACE
      ? "This content type belongs to the merchant."
      : `This content type belongs to the app ${namespace}; it changes it.`, { namespace });
    this.name = "MetaobjectNamespaceError";
  }
}

// ── Shapes ──────────────────────────────────────────────────────────────────

export interface MetaobjectDefinitionView {
  id: string;
  /** `<namespace>.<type>`. */
  handle: string;
  namespace: string;
  type: string;
  name: string;
  description: string | null;
  fields: MetaobjectFieldDefinition[];
  displayField: string | null;
  storefrontAccess: boolean;
  /** Who changes the definition: the merchant (`custom`) or the app that owns it. */
  owner: "merchant" | "app";
  entryCount: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface MetaobjectEntryView {
  id: string;
  definitionId: string;
  handle: string;
  /** The display field's value, else the handle. */
  displayName: string;
  status: MetaobjectEntryStatus;
  /** Field key → wire value (the custom-field contract: money in major units). */
  fields: Record<string, unknown>;
  position: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

const iso = (seconds: number) => new Date(Number(seconds) * 1000).toISOString();

/** Entries of the row's definition (qualified by hand: a nested selection renders the outer column bare). */
const ENTRY_COUNT = sql<number>`(SELECT count(*) FROM metaobject_entries AS counted WHERE counted.definition_id = "metaobject_definitions"."id")`;

async function codecContext(db: Database): Promise<CustomFieldCodecContext> {
  const currency = await readStoreCurrency(db);
  return { decimalPlaces: currency.decimalPlaces, currencyCode: currency.code, priceIncrementMinor: currency.priceIncrementMinor };
}

function readFields(text: string): MetaobjectFieldDefinition[] {
  try {
    const parsed = metaobjectFieldListSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

function readValues(text: string): Record<string, string> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

function presentDefinition(row: MetaobjectDefinitionRow, entryCount: number): MetaobjectDefinitionView {
  const fields = readFields(row.fields);
  return {
    id: row.id,
    handle: metaobjectHandle(row.namespace, row.type),
    namespace: row.namespace,
    type: row.type,
    name: row.name,
    description: row.description,
    fields,
    displayField: metaobjectDisplayField(fields, row.displayField),
    storefrontAccess: Boolean(row.storefrontAccess),
    owner: row.namespace === METAOBJECT_MERCHANT_NAMESPACE ? "merchant" : "app",
    entryCount,
    revision: Number(row.revision),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Stored values as the HTTP contract carries them; a value the definition no longer reads is left out. */
export function presentMetaobjectEntry(
  row: MetaobjectEntryRow,
  definition: Pick<MetaobjectDefinitionView, "fields" | "displayField">,
  context: CustomFieldCodecContext,
): MetaobjectEntryView {
  const stored = readValues(row.fields);
  const fields: Record<string, unknown> = {};
  for (const field of definition.fields) {
    const value = stored[field.key];
    if (value !== undefined) fields[field.key] = customFieldWireValue(field.type, value, context);
  }
  const display = definition.displayField ? fields[definition.displayField] : undefined;
  return {
    id: row.id,
    definitionId: row.definitionId,
    handle: row.handle,
    displayName: typeof display === "string" && display.trim() ? display.trim().slice(0, 200) : row.handle,
    status: row.status,
    fields,
    position: Number(row.position),
    revision: Number(row.revision),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

function isUniqueError(error: unknown, index: string): boolean {
  for (let current: unknown = error, hops = 0; current && hops < 5; hops += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (message.includes(index) || /UNIQUE constraint failed: metaobject_/i.test(message)) return true;
    current = current instanceof Error ? (current as Error & { cause?: unknown }).cause : undefined;
  }
  return false;
}

function namespaceOf(writer: MetaobjectWriter): string {
  return writer.kind === "merchant" ? METAOBJECT_MERCHANT_NAMESPACE : writer.pluginId;
}

function assertOwns(writer: MetaobjectWriter, namespace: string): void {
  if (namespaceOf(writer) !== namespace) throw new MetaobjectNamespaceError(namespace);
}

function parseDefinition(input: unknown) {
  const parsed = metaobjectDefinitionInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ValidationError(issue?.message ?? "Check the content type.", {
      issues: parsed.error.issues.slice(0, 20).map((entry) => ({ path: entry.path.map(String), code: "invalid", message: entry.message })),
    });
  }
  return parsed.data;
}

// ── Definitions ─────────────────────────────────────────────────────────────

export async function listMetaobjectDefinitions(db: Database): Promise<MetaobjectDefinitionView[]> {
  const rows = await db.select({
    row: metaobjectDefinitions,
    entryCount: ENTRY_COUNT,
  }).from(metaobjectDefinitions)
    .orderBy(asc(metaobjectDefinitions.name), asc(metaobjectDefinitions.id))
    .all();
  return rows.map(({ row, entryCount }) => presentDefinition(row, Number(entryCount ?? 0)));
}

export async function getMetaobjectDefinition(db: Database, id: string): Promise<MetaobjectDefinitionView | null> {
  const found = await db.select({
    row: metaobjectDefinitions,
    entryCount: ENTRY_COUNT,
  }).from(metaobjectDefinitions).where(eq(metaobjectDefinitions.id, id)).get();
  return found ? presentDefinition(found.row, Number(found.entryCount ?? 0)) : null;
}

async function requireDefinition(db: Database, id: string): Promise<MetaobjectDefinitionView> {
  const definition = await getMetaobjectDefinition(db, id);
  if (!definition) throw new NotFoundError("Content type not found");
  return definition;
}

export async function createMetaobjectDefinition(
  db: Database,
  input: MetaobjectDefinitionInput,
  writer: MetaobjectWriter = MERCHANT_METAOBJECT_WRITER,
): Promise<MetaobjectDefinitionView> {
  const spec = parseDefinition(input);
  const total = await db.select({ n: count() }).from(metaobjectDefinitions).get();
  if (Number(total?.n ?? 0) >= METAOBJECT_DEFINITIONS_MAX) {
    throw new AppError(409, METAOBJECT_LIMIT, `A store holds at most ${METAOBJECT_DEFINITIONS_MAX} content types.`);
  }
  const id = `${METAOBJECT_DEFINITION_ID_PREFIX}${nanoid(16)}`;
  try {
    await db.insert(metaobjectDefinitions).values({
      id,
      namespace: namespaceOf(writer),
      type: spec.type,
      name: spec.name,
      description: spec.description ?? null,
      fields: JSON.stringify(spec.fields),
      displayField: spec.displayField ?? null,
      storefrontAccess: spec.storefrontAccess,
    });
  } catch (error) {
    if (isUniqueError(error, "metaobject_definitions_namespace_type_unique")) {
      throw new AppError(409, METAOBJECT_TYPE_TAKEN, `A content type ${metaobjectHandle(namespaceOf(writer), spec.type)} already exists.`);
    }
    throw error;
  }
  return requireDefinition(db, id);
}

/**
 * Changes a definition at the revision the editor read. A field's type
 * cannot change once entries hold a value for it (add a new field instead);
 * removing a field keeps its stored values out of every read.
 */
export async function updateMetaobjectDefinition(
  db: Database,
  id: string,
  input: { expectedRevision: number } & Omit<MetaobjectDefinitionInput, "type">,
  writer: MetaobjectWriter = MERCHANT_METAOBJECT_WRITER,
): Promise<MetaobjectDefinitionView> {
  const current = await requireDefinition(db, id);
  assertOwns(writer, current.namespace);
  const { expectedRevision, ...rest } = input;
  const spec = parseDefinition({ ...rest, type: current.type });
  await assertFieldTypesKept(db, current, spec.fields);
  const updated = await db.update(metaobjectDefinitions).set({
    name: spec.name,
    description: spec.description ?? null,
    fields: JSON.stringify(spec.fields),
    displayField: spec.displayField ?? null,
    storefrontAccess: spec.storefrontAccess,
    revision: sql`${metaobjectDefinitions.revision} + 1`,
    updatedAt: sql`unixepoch()`,
  }).where(and(eq(metaobjectDefinitions.id, id), eq(metaobjectDefinitions.revision, expectedRevision)))
    .returning({ id: metaobjectDefinitions.id });
  if (updated.length === 0) throw new MetaobjectRevisionConflictError(id, expectedRevision);
  return requireDefinition(db, id);
}

async function assertFieldTypesKept(db: Database, current: MetaobjectDefinitionView, next: readonly MetaobjectFieldDefinition[]): Promise<void> {
  const changed = next.filter((field) => {
    const before = current.fields.find((entry) => entry.key === field.key);
    return before !== undefined && before.type !== field.type;
  });
  if (changed.length === 0 || current.entryCount === 0) return;
  for (const field of changed) {
    const used = await db.select({ id: metaobjectEntries.id }).from(metaobjectEntries)
      .where(and(eq(metaobjectEntries.definitionId, current.id), sql`json_extract(${metaobjectEntries.fields}, ${`$.${field.key}`}) IS NOT NULL`))
      .limit(1).get();
    if (used) {
      throw new ValidationError(`Entries hold values for ${field.name}: add a new field instead of changing its type.`, {
        issues: [{ path: ["fields", field.key, "type"], code: "invalid", message: "Entries hold values of this field." }],
      });
    }
  }
}

export async function deleteMetaobjectDefinition(
  db: Database,
  id: string,
  expectedRevision: number,
  writer: MetaobjectWriter = MERCHANT_METAOBJECT_WRITER,
): Promise<void> {
  const current = await getMetaobjectDefinition(db, id);
  if (!current) return;
  assertOwns(writer, current.namespace);
  const deleted = await db.delete(metaobjectDefinitions)
    .where(and(eq(metaobjectDefinitions.id, id), eq(metaobjectDefinitions.revision, expectedRevision)))
    .returning({ id: metaobjectDefinitions.id });
  if (deleted.length === 0) throw new MetaobjectRevisionConflictError(id, expectedRevision);
}

/**
 * An app's content types as its manifest declares them, in its namespace:
 * new ones are created, changed ones updated (a field type that entries
 * use is kept and reported). Types the manifest no longer declares stay
 * with their entries (data is never dropped by an update). Returns what
 * could not be applied.
 */
export async function syncAppMetaobjectDefinitions(
  db: Database,
  pluginId: string,
  declared: readonly MetaobjectDefinitionInput[],
): Promise<string[]> {
  const problems: string[] = [];
  const existing = new Map((await db.select().from(metaobjectDefinitions)
    .where(eq(metaobjectDefinitions.namespace, pluginId)).all()).map((row) => [row.type, row]));
  const writer: MetaobjectWriter = { kind: "plugin", pluginId };
  for (const input of declared) {
    const spec = parseDefinition(input);
    const row = existing.get(spec.type);
    try {
      if (!row) {
        await createMetaobjectDefinition(db, spec, writer);
        continue;
      }
      const same = row.name === spec.name && (row.description ?? undefined) === spec.description
        && row.fields === JSON.stringify(spec.fields) && (row.displayField ?? undefined) === spec.displayField
        && Boolean(row.storefrontAccess) === spec.storefrontAccess;
      if (!same) await updateMetaobjectDefinition(db, row.id, { ...spec, expectedRevision: Number(row.revision) }, writer);
    } catch (error) {
      problems.push(`${metaobjectHandle(pluginId, spec.type)}: ${error instanceof Error ? error.message.slice(0, 200) : "could not be saved"}`);
    }
  }
  return problems;
}

// ── Entries ─────────────────────────────────────────────────────────────────

export interface MetaobjectEntryInput {
  handle?: string;
  status?: MetaobjectEntryStatus;
  /** Field key → wire value (null or "" clears it). */
  fields?: Record<string, unknown>;
  position?: number;
}

/** Validates wire values against the definition, merged over the stored ones: the stored canonical texts. */
function canonicalValues(
  definition: MetaobjectDefinitionView,
  stored: Record<string, string>,
  input: Record<string, unknown> | undefined,
  context: CustomFieldCodecContext,
  status: MetaobjectEntryStatus,
): Record<string, string> {
  const values = { ...stored };
  const fields = new Map(definition.fields.map((field) => [field.key, field]));
  for (const [key, raw] of Object.entries(input ?? {})) {
    const field = fields.get(key);
    if (!field) {
      throw new ValidationError(`${definition.name} has no field ${key.slice(0, 64)}.`, { issues: [{ path: ["fields", key], code: "unknown", message: "Unknown field." }] });
    }
    const parsed = parseCustomFieldValue({ type: field.type, validations: {} }, raw, context);
    if (!parsed.ok) {
      throw new ValidationError(`${field.name}: ${parsed.issue.message}`, {
        issues: [{ path: ["fields", key, ...(parsed.issue.index === undefined ? [] : [parsed.issue.index])], code: parsed.issue.code, message: parsed.issue.message }],
      });
    }
    if (parsed.value === null) delete values[key];
    else values[key] = parsed.value;
  }
  // A published entry has every required field.
  if (status === "published") {
    const missing = definition.fields.filter((field) => field.required && values[field.key] === undefined);
    if (missing.length > 0) {
      throw new ValidationError(`Fill in ${missing.map((field) => field.name).join(", ")} before publishing.`, {
        issues: missing.map((field) => ({ path: ["fields", field.key], code: "required", message: "Required to publish." })),
      });
    }
  }
  // Only fields the definition still has are kept.
  return Object.fromEntries(Object.entries(values).filter(([key]) => fields.has(key)));
}

export async function listMetaobjectEntries(
  db: Database,
  definitionId: string,
  options: { status?: MetaobjectEntryStatus; limit?: number; offset?: number } = {},
): Promise<{ definition: MetaobjectDefinitionView; entries: MetaobjectEntryView[]; total: number }> {
  const definition = await requireDefinition(db, definitionId);
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const where = and(eq(metaobjectEntries.definitionId, definitionId), options.status ? eq(metaobjectEntries.status, options.status) : undefined);
  const [context, rows, total] = await Promise.all([
    codecContext(db),
    db.select().from(metaobjectEntries).where(where)
      .orderBy(asc(metaobjectEntries.position), asc(metaobjectEntries.id))
      .limit(limit).offset(Math.max(options.offset ?? 0, 0)).all(),
    db.select({ n: count() }).from(metaobjectEntries).where(where).get(),
  ]);
  return { definition, entries: rows.map((row) => presentMetaobjectEntry(row, definition, context)), total: Number(total?.n ?? 0) };
}

export async function getMetaobjectEntry(db: Database, definitionId: string, entryId: string): Promise<MetaobjectEntryView | null> {
  const [definition, row, context] = await Promise.all([
    getMetaobjectDefinition(db, definitionId),
    db.select().from(metaobjectEntries).where(and(eq(metaobjectEntries.id, entryId), eq(metaobjectEntries.definitionId, definitionId))).get(),
    codecContext(db),
  ]);
  return definition && row ? presentMetaobjectEntry(row, definition, context) : null;
}

function requireHandle(handle: string): string {
  if (!METAOBJECT_HANDLE_PATTERN.test(handle)) {
    throw new ValidationError("Use lowercase letters, digits and dashes for the handle.", { issues: [{ path: ["handle"], code: "invalid", message: "Invalid handle." }] });
  }
  return handle;
}

export async function createMetaobjectEntry(db: Database, definitionId: string, input: MetaobjectEntryInput): Promise<MetaobjectEntryView> {
  const [definition, context] = await Promise.all([requireDefinition(db, definitionId), codecContext(db)]);
  if (definition.entryCount >= METAOBJECT_ENTRIES_PER_DEFINITION_MAX) {
    throw new AppError(409, METAOBJECT_LIMIT, `A content type holds at most ${METAOBJECT_ENTRIES_PER_DEFINITION_MAX} entries.`);
  }
  const status = input.status ?? "draft";
  const values = canonicalValues(definition, {}, input.fields, context, status);
  const title = definition.displayField ? values[definition.displayField] : undefined;
  const handle = requireHandle(input.handle?.trim() || metaobjectHandleFrom(title ?? `entry-${nanoid(6).toLowerCase()}`));
  const id = `${METAOBJECT_ENTRY_ID_PREFIX}${nanoid(16)}`;
  try {
    await db.insert(metaobjectEntries).values({
      id,
      definitionId,
      handle,
      status,
      fields: JSON.stringify(values),
      position: input.position ?? definition.entryCount,
    });
  } catch (error) {
    if (isUniqueError(error, "metaobject_entries_definition_handle_unique")) {
      throw new AppError(409, METAOBJECT_HANDLE_TAKEN, `An entry with the handle ${handle} already exists.`);
    }
    throw error;
  }
  return (await getMetaobjectEntry(db, definitionId, id))!;
}

export async function updateMetaobjectEntry(
  db: Database,
  definitionId: string,
  entryId: string,
  input: MetaobjectEntryInput & { expectedRevision: number },
): Promise<MetaobjectEntryView> {
  const [definition, row, context] = await Promise.all([
    requireDefinition(db, definitionId),
    db.select().from(metaobjectEntries).where(and(eq(metaobjectEntries.id, entryId), eq(metaobjectEntries.definitionId, definitionId))).get(),
    codecContext(db),
  ]);
  if (!row) throw new NotFoundError("Entry not found");
  const status = input.status ?? row.status;
  const values = canonicalValues(definition, readValues(row.fields), input.fields, context, status);
  try {
    const updated = await db.update(metaobjectEntries).set({
      ...(input.handle !== undefined ? { handle: requireHandle(input.handle.trim()) } : {}),
      status,
      fields: JSON.stringify(values),
      ...(input.position !== undefined ? { position: input.position } : {}),
      revision: sql`${metaobjectEntries.revision} + 1`,
      updatedAt: sql`unixepoch()`,
    }).where(and(eq(metaobjectEntries.id, entryId), eq(metaobjectEntries.revision, input.expectedRevision)))
      .returning({ id: metaobjectEntries.id });
    if (updated.length === 0) throw new MetaobjectRevisionConflictError(entryId, input.expectedRevision);
  } catch (error) {
    if (isUniqueError(error, "metaobject_entries_definition_handle_unique")) {
      throw new AppError(409, METAOBJECT_HANDLE_TAKEN, `An entry with the handle ${input.handle ?? ""} already exists.`);
    }
    throw error;
  }
  return (await getMetaobjectEntry(db, definitionId, entryId))!;
}

export async function deleteMetaobjectEntry(db: Database, definitionId: string, entryId: string, expectedRevision: number): Promise<void> {
  const deleted = await db.delete(metaobjectEntries)
    .where(and(eq(metaobjectEntries.id, entryId), eq(metaobjectEntries.definitionId, definitionId), eq(metaobjectEntries.revision, expectedRevision)))
    .returning({ id: metaobjectEntries.id });
  if (deleted.length > 0) return;
  const exists = await db.select({ id: metaobjectEntries.id }).from(metaobjectEntries).where(eq(metaobjectEntries.id, entryId)).get();
  if (exists) throw new MetaobjectRevisionConflictError(entryId, expectedRevision);
}

/** Deletes an app's content types and their entries (its uninstall with delete-data). */
export async function deleteAppMetaobjects(db: Database, pluginId: string): Promise<void> {
  await db.delete(metaobjectDefinitions).where(eq(metaobjectDefinitions.namespace, pluginId));
}
