import { appScopedKey, appScopedKeyAppId, isAppScopedKey } from "./plugins/ids";
import { sha256HexSync } from "./hash";
import { LINE_ADJUSTMENT_KEY, LINE_BUNDLE_KEY, LINE_ENTRY_WORDS_EN } from "./line-entry-words";
import {
  LINE_PROPERTY_INPUT_LIMITS,
  LINE_PROPERTY_REVISION_PATTERN,
  LINE_PURCHASE_OPTION_PROPERTY_KEY,
  lineAnswerRevision as answerRevision,
  type CanonicalLineProperty,
  type LinePropertyInput,
} from "./line-identity";
import {
  BUYER_UPLOAD_DECLARATION_LIMITS,
  BUYER_UPLOAD_TYPES,
  buyerUploadDisplayValue,
  formatBuyerUploadValue,
  parseBuyerUploadValue,
  type BuyerUploadType,
} from "./buyer-upload-value";
/**
 * Line-item properties: the buyer inputs a product asks for (engraving text,
 * gift wrap, a fit choice) and what they add to the line price (Wave A §3).
 *
 * The merchant's schema lives on `products.customization_schema`. A cart
 * line carries `properties: [{ key, value }]`; the server resolves them
 * against the schema, prices the line as `base + surcharges`, and freezes a
 * labelled snapshot on `order_items.properties`. Storefront and API share
 * these functions so a cart line key and a committed line always agree.
 *
 * Properties are buyer content: never put them in URLs, analytics, logs or
 * queue payloads.
 */

export {
  LINE_PROPERTY_INPUT_LIMITS,
  LINE_PROPERTY_REVISION_PATTERN,
  LINE_PURCHASE_OPTION_PROPERTY_KEY,
  LINE_PURCHASE_OPTIONS_MAX,
  NO_PROPERTIES_HASH,
  lineCartKey,
  lineAnswerRevision,
  lineIdentityProperties,
  linePropertiesHash,
  linePropertyInputOf,
  normalizeLinePurchaseOptions,
  type CanonicalLineProperty,
  type LinePropertyInput,
  type LinePurchaseOptionsResult,
} from "./line-identity";

export const CUSTOMIZATION_SCHEMA_VERSION = 1 as const;
export const CUSTOMIZATION_FIELD_TYPES = ["text", "textarea", "select", "checkbox"] as const;
export type CustomizationFieldType = (typeof CUSTOMIZATION_FIELD_TYPES)[number];
/**
 * What a line input may be: the product's own types, and `file` (an app's
 * line input only: buyer uploads, `@scalius/shared/buyer-uploads`).
 */
export const LINE_INPUT_FIELD_TYPES = [...CUSTOMIZATION_FIELD_TYPES, "file"] as const;
export type LineInputFieldType = (typeof LINE_INPUT_FIELD_TYPES)[number];

export const CUSTOMIZATION_LIMITS = {
  fields: 10,
  keyPattern: /^[a-z0-9_]{1,40}$/,
  labelLength: 60,
  helpLength: 200,
  textMaxLength: 200,
  textareaMaxLength: 1_000,
  selectOptions: 20,
  optionValueLength: 60,
  optionLabelLength: 60,
  /** Largest surcharge per field or option, in minor units. */
  priceMinor: 10_000_000_000,
  /** Serialized schema bound; the `products` CHECK enforces the same number. */
  serializedLength: 4_096,
} as const;

/** What a choice's confirmation (`options[].confirm`) and an input's bulk actions hold. */
export const LINE_INPUT_CONFIRM_LIMITS = {
  textLength: 1_000,
  labelLength: 120,
  /** An answer's `revision` (the input's `textRevision`). */
  revisionLength: 64,
} as const;

/**
 * The words of an app's line input (`checkout.lineInputs`), which a merchant
 * may write as legal copy (a decline agreement) through a setting: a field
 * label stays short, but a checkbox's label (what the buyer agrees to) and
 * any input's help take up to 1,000 characters. 1,000 holds a consent clause
 * (GameGhor's decline is about 230; a store's terms paragraph 300 to 800),
 * is the longest answer a buyer may give (`LINE_PROPERTY_INPUT_LIMITS.valueLength`),
 * and keeps a line inside its frozen bound: a frozen entry carries its label,
 * and 40 of them with 1,000-character labels stay under
 * `LINE_PROPERTY_INPUT_LIMITS.serializedLength` (help is never frozen). The
 * product's own inputs keep `CUSTOMIZATION_LIMITS` (its schema is stored on
 * the product row under a 4 KiB CHECK).
 */
export const APP_LINE_INPUT_TEXT_LIMITS = {
  label: CUSTOMIZATION_LIMITS.labelLength,
  /** A checkbox's label: the agreement the buyer ticks. */
  agreement: 1_000,
  help: 1_000,
  optionLabel: CUSTOMIZATION_LIMITS.optionLabelLength,
} as const;

/** Serialized snapshot bound; the `order_items.properties` CHECK enforces the same number. */
export const ORDER_LINE_PROPERTIES_MAX_LENGTH = 65_536;

/** Keys with this prefix carry gift-card recipient details (Wave B) and are reserved. */
export const RESERVED_PROPERTY_KEY_PREFIX = "_gc_";

interface CustomizationFieldBase {
  key: string;
  label: string;
  required: boolean;
  help: string | null;
  /**
   * The app that asks for it (manifest `checkout.lineInputs`; its key is then
   * `<app id>.<key>`). Absent for the merchant's own inputs, which a stored
   * schema never carries.
   */
  appId?: string;
  /**
   * An app input whose words the merchant writes, or with a choice that needs
   * confirmation: their revision (`AppLineInputDeclaration.textRevision`). An
   * answer to a choice that needs confirmation must carry it.
   */
  textRevision?: string;
}

export interface CustomizationTextField extends CustomizationFieldBase {
  type: "text" | "textarea";
  maxLength: number;
  /** Added once when the buyer fills the field. */
  priceMinor: number;
}

export interface CustomizationCheckboxField extends CustomizationFieldBase {
  type: "checkbox";
  /** Added when the buyer ticks the box. A required checkbox must be ticked. */
  priceMinor: number;
}

export interface CustomizationSelectOption {
  value: string;
  label: string;
  priceMinor: number;
  /** An app's choice the buyer takes only after agreeing to `text` (`LineInputConfirm`). */
  confirm?: LineInputConfirm;
}

/** What the buyer agrees to before an app's choice is taken (manifest `options[].confirm`). */
export interface LineInputConfirm {
  text: string;
  title?: string;
  agree?: string;
}

/** An app's bulk actions on one input (manifest `bulk`). */
export interface LineInputBulk {
  apply?: { label: string; value?: string };
  clear?: { label: string };
}

export interface CustomizationSelectField extends CustomizationFieldBase {
  type: "select";
  options: CustomizationSelectOption[];
}

/**
 * An app's `file` line input: the answer is the ids of the buyer's uploads
 * (`bup_...`, joined by commas), at most `maxFiles`. Never in a stored product
 * schema; priced at nothing like every app input.
 */
export interface CustomizationFileField extends CustomizationFieldBase {
  type: "file";
  accept: readonly BuyerUploadType[];
  maxBytes: number;
  maxFiles: number;
  priceMinor: 0;
}

export type CustomizationField =
  | CustomizationTextField
  | CustomizationCheckboxField
  | CustomizationSelectField
  | CustomizationFileField;

export interface CustomizationSchema {
  version: typeof CUSTOMIZATION_SCHEMA_VERSION;
  fields: CustomizationField[];
}

export interface CustomizationSchemaOptions {
  /** Surcharges must be multiples of this (100 for whole-taka BDT stores). */
  priceStepMinor?: number;
  /** Gift-card products may use the reserved `_gc_` keys (Wave B). */
  allowReservedKeys?: boolean;
}

export type CustomizationSchemaResult =
  | { ok: true; schema: CustomizationSchema | null }
  | { ok: false; issues: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function characterLength(value: string): number {
  let length = 0;
  for (const _character of value) length += 1;
  return length;
}

/** NFC, trimmed. The one text normalization for schema text and buyer values. */
export function normalizePropertyText(value: string): string {
  return value.normalize("NFC").trim();
}

// C0/C1 controls other than tab, line feed and carriage return.
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}
const LINE_BREAKS = /[\r\n]/;

function readText(
  issues: string[],
  path: string,
  value: unknown,
  maxLength: number,
  { optional }: { optional: boolean },
): string | null {
  if (value === undefined || value === null) {
    if (!optional) issues.push(`${path} is required`);
    return null;
  }
  if (typeof value !== "string") {
    issues.push(`${path} must be text`);
    return null;
  }
  const text = normalizePropertyText(value);
  if (!text) {
    if (!optional) issues.push(`${path} is required`);
    return null;
  }
  if (characterLength(text) > maxLength) issues.push(`${path} must be at most ${maxLength} characters`);
  if (hasControlCharacter(text) || LINE_BREAKS.test(text)) issues.push(`${path} must be one line of text`);
  return text;
}

function readPrice(
  issues: string[],
  path: string,
  value: unknown,
  options: CustomizationSchemaOptions,
): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 0
    || value > CUSTOMIZATION_LIMITS.priceMinor
  ) {
    issues.push(`${path} must be a whole number of minor units from 0`);
    return 0;
  }
  const step = options.priceStepMinor ?? 1;
  if (step > 1 && value % step !== 0) issues.push(`${path} must be a multiple of ${step}`);
  return value;
}

function readMaxLength(issues: string[], path: string, value: unknown, limit: number): number {
  if (value === undefined || value === null) return limit;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > limit) {
    issues.push(`${path} must be a whole number from 1 to ${limit}`);
    return limit;
  }
  return value;
}

function readField(
  issues: string[],
  index: number,
  raw: unknown,
  options: CustomizationSchemaOptions,
): CustomizationField | null {
  const path = `fields[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${path} must be an object`);
    return null;
  }
  const key = typeof raw.key === "string" ? raw.key : "";
  if (!CUSTOMIZATION_LIMITS.keyPattern.test(key)) {
    issues.push(`${path}.key must be 1-40 lowercase letters, digits or underscores`);
  } else if (key.startsWith(RESERVED_PROPERTY_KEY_PREFIX) && !options.allowReservedKeys) {
    issues.push(`${path}.key uses the reserved ${RESERVED_PROPERTY_KEY_PREFIX} prefix`);
  }
  const label = readText(issues, `${path}.label`, raw.label, CUSTOMIZATION_LIMITS.labelLength, { optional: false }) ?? "";
  const help = readText(issues, `${path}.help`, raw.help, CUSTOMIZATION_LIMITS.helpLength, { optional: true });
  if (raw.required !== undefined && typeof raw.required !== "boolean") {
    issues.push(`${path}.required must be true or false`);
  }
  const base = { key, label, required: raw.required === true, help };

  switch (raw.type) {
    case "text":
    case "textarea": {
      const limit = raw.type === "text"
        ? CUSTOMIZATION_LIMITS.textMaxLength
        : CUSTOMIZATION_LIMITS.textareaMaxLength;
      if (raw.options !== undefined) issues.push(`${path}.options are only for select fields`);
      return {
        ...base,
        type: raw.type,
        maxLength: readMaxLength(issues, `${path}.maxLength`, raw.maxLength, limit),
        priceMinor: readPrice(issues, `${path}.priceMinor`, raw.priceMinor, options),
      };
    }
    case "checkbox":
      if (raw.options !== undefined) issues.push(`${path}.options are only for select fields`);
      if (raw.maxLength !== undefined) issues.push(`${path}.maxLength is only for text fields`);
      return {
        ...base,
        type: "checkbox",
        priceMinor: readPrice(issues, `${path}.priceMinor`, raw.priceMinor, options),
      };
    case "select": {
      if (raw.priceMinor !== undefined) issues.push(`${path}.priceMinor belongs on each option`);
      if (raw.maxLength !== undefined) issues.push(`${path}.maxLength is only for text fields`);
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        issues.push(`${path}.options must list at least one choice`);
        return { ...base, type: "select", options: [] };
      }
      if (raw.options.length > CUSTOMIZATION_LIMITS.selectOptions) {
        issues.push(`${path}.options must have at most ${CUSTOMIZATION_LIMITS.selectOptions} choices`);
      }
      const seen = new Set<string>();
      const choices = raw.options.map((option, optionIndex): CustomizationSelectOption => {
        const optionPath = `${path}.options[${optionIndex}]`;
        if (!isRecord(option)) {
          issues.push(`${optionPath} must be an object`);
          return { value: "", label: "", priceMinor: 0 };
        }
        const value = readText(
          issues,
          `${optionPath}.value`,
          option.value,
          CUSTOMIZATION_LIMITS.optionValueLength,
          { optional: false },
        ) ?? "";
        if (value && seen.has(value)) issues.push(`${optionPath}.value repeats another choice`);
        seen.add(value);
        return {
          value,
          label: readText(
            issues,
            `${optionPath}.label`,
            option.label,
            CUSTOMIZATION_LIMITS.optionLabelLength,
            { optional: false },
          ) ?? "",
          priceMinor: readPrice(issues, `${optionPath}.priceMinor`, option.priceMinor, options),
        };
      });
      return { ...base, type: "select", options: choices };
    }
    default:
      issues.push(`${path}.type must be one of ${CUSTOMIZATION_FIELD_TYPES.join(", ")}`);
      return null;
  }
}

/**
 * Validate and normalize a merchant schema. `null`, `undefined` and a schema
 * without fields all mean "no buyer inputs" (`schema: null`).
 */
export function parseCustomizationSchema(
  input: unknown,
  options: CustomizationSchemaOptions = {},
): CustomizationSchemaResult {
  if (input === null || input === undefined) return { ok: true, schema: null };
  if (!isRecord(input)) return { ok: false, issues: ["customization schema must be an object"] };
  const issues: string[] = [];
  if (input.version !== CUSTOMIZATION_SCHEMA_VERSION) {
    issues.push(`version must be ${CUSTOMIZATION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(input.fields)) {
    return { ok: false, issues: [...issues, "fields must be a list"] };
  }
  if (input.fields.length > CUSTOMIZATION_LIMITS.fields) {
    issues.push(`fields must have at most ${CUSTOMIZATION_LIMITS.fields} entries`);
  }
  const fields = input.fields
    .map((field, index) => readField(issues, index, field, options))
    .filter((field): field is CustomizationField => field !== null);
  const keys = new Set<string>();
  for (const field of fields) {
    if (keys.has(field.key)) issues.push(`field key ${field.key} is used twice`);
    keys.add(field.key);
  }
  if (issues.length > 0) return { ok: false, issues };
  if (fields.length === 0) return { ok: true, schema: null };
  const schema: CustomizationSchema = { version: CUSTOMIZATION_SCHEMA_VERSION, fields };
  if (serializeCustomizationSchema(schema).length > CUSTOMIZATION_LIMITS.serializedLength) {
    return {
      ok: false,
      issues: [`customization schema must serialize to at most ${CUSTOMIZATION_LIMITS.serializedLength} characters`],
    };
  }
  return { ok: true, schema };
}

/** Read the stored column. A malformed value is a product error, never "no inputs". */
export function parseStoredCustomizationSchema(
  stored: string | null | undefined,
  options: CustomizationSchemaOptions = {},
): CustomizationSchemaResult {
  if (stored === null || stored === undefined) return { ok: true, schema: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return { ok: false, issues: ["customization schema is not valid JSON"] };
  }
  // A stored gift-card schema may carry reserved keys; the write path decided.
  return parseCustomizationSchema(parsed, { ...options, allowReservedKeys: true });
}

export function serializeCustomizationSchema(schema: CustomizationSchema): string {
  return JSON.stringify(schema);
}

/** Whether the buyer must fill something before the line can be bought. */
export function hasRequiredCustomization(schema: CustomizationSchema | null): boolean {
  return schema?.fields.some((field) => field.required) ?? false;
}

// ---------------------------------------------------------------------------
// Buyer values
// ---------------------------------------------------------------------------

/**
 * An app's add-on to a line (`cart.line_prices` adjustments), frozen on the
 * order line beside its buyer inputs as "Add-on: <title> (+price)". It is
 * never a buyer input: it is not sent back by the cart and has no identity.
 */
export const LINE_ADJUSTMENT_PROPERTY_KEY = LINE_ADJUSTMENT_KEY;
/** Stored in English for the API; every surface draws it in its reader's language (`presentLineEntry`). */
export const LINE_ADJUSTMENT_LABEL = LINE_ENTRY_WORDS_EN.lineAddOnText;

export function lineAdjustmentProperty(title: string, amountMinor: number, appId?: string): ResolvedLineProperty {
  const text = title.trim().slice(0, 80);
  return { key: LINE_ADJUSTMENT_PROPERTY_KEY, type: "text", label: LINE_ADJUSTMENT_LABEL, value: text, displayValue: text, priceMinor: amountMinor, ...(appId ? { appId } : {}) };
}

/**
 * A line's purchase option (an app's `checkout.purchaseOptions`, "Subscribe
 * and save"), frozen on the order line after its buyer inputs: `value` is the
 * option's public id `<app id>.<key>`, `displayValue` its title, `appId` its
 * app. A line carries at most one option of each app, each frozen as its own
 * entry. The key is a contract: payments ask the provider to keep the buyer's
 * payment method when an order has such a line. It is not a buyer input (no
 * price, never sent back as a property); the cart sends the line's
 * `purchaseOptions`, and they are part of its identity (`lineIdentityProperties`).
 */
export const LINE_PURCHASE_OPTION_LABEL = LINE_ENTRY_WORDS_EN.linePurchaseOptionText;

export function linePurchaseOptionProperty(id: string, title: string): ResolvedLineProperty {
  const text = title.trim().slice(0, 80);
  const appId = appScopedKeyAppId(id);
  return { key: LINE_PURCHASE_OPTION_PROPERTY_KEY, type: "text", label: LINE_PURCHASE_OPTION_LABEL, value: id, displayValue: text, priceMinor: 0, ...(appId ? { appId } : {}) };
}

function frozenEntries(properties: string | readonly unknown[] | null | undefined): unknown[] {
  if (typeof properties !== "string") return Array.isArray(properties) ? [...properties] : [];
  try {
    const parsed: unknown = JSON.parse(properties);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** The purchase options frozen on an order line (`order_items.properties` JSON or entries), sorted by id. */
export function readLinePurchaseOptions(properties: string | readonly unknown[] | null | undefined): string[] {
  const options = new Set<string>();
  for (const entry of frozenEntries(properties)) {
    if (isRecord(entry) && entry.key === LINE_PURCHASE_OPTION_PROPERTY_KEY && isAppScopedKey(entry.value)) options.add(entry.value);
  }
  return [...options].sort();
}

/** A transformed line's bundle (`cart.transform`), frozen beside its inputs as its title. */
export const LINE_BUNDLE_PROPERTY_KEY = LINE_BUNDLE_KEY;

/**
 * A bundle line's membership as checkout freezes it on the line's `_bundle`
 * entry (`cart.transform`): which bought bundle the line is part of and its
 * share of each bundle unit, so whoever reads the order counts bundle units
 * without guessing from the lines' quantities.
 */
export interface OrderLineBundle {
  /** The bought bundle, unique within its order: the buyer line's id at checkout (`cart:<index>:<variant>`), the id functions saw. */
  id: string;
  title: string;
  kind: "expand" | "merge";
  /**
   * The one line of the bundle its buyer inputs and app add-ons are frozen
   * on: an expanded bundle's component holding the fewest per bundle unit
   * (the first such), a merged bundle's first line.
   */
  anchor: boolean;
  /** An expanded bundle's units bought (the buyer's bundle quantity); null for a merged bundle, whose lines keep their own quantities. */
  units: number | null;
  /** This line's units in each bundle unit (`quantity = units × perUnit`); null for a merged bundle. */
  perUnit: number | null;
}

/** The facts a `_bundle` entry carries beside its title. */
type FrozenBundleFacts = Omit<OrderLineBundle, "title">;

/** A bundle line's `_bundle` entry: its title, as every surface shows it, and its membership. */
export function lineBundleProperty(bundle: OrderLineBundle): ResolvedLineProperty & { bundle: FrozenBundleFacts } {
  const title = bundle.title.slice(0, 200);
  return {
    key: LINE_BUNDLE_PROPERTY_KEY, type: "text", label: LINE_ENTRY_WORDS_EN.lineBundleText, value: title, displayValue: title, priceMinor: 0,
    bundle: { id: bundle.id, kind: bundle.kind, anchor: bundle.anchor, units: bundle.units, perUnit: bundle.perUnit },
  };
}

const positiveCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * The bundle an order line is part of, as checkout froze it, or null: a
 * plain line, a line frozen before membership was recorded (its `_bundle`
 * entry has the title alone), or a malformed entry. An expanded bundle's
 * units are given only while the line still holds `units × perUnit`
 * (`quantity`): a line whose quantity staff changed since reads them null,
 * never a guess.
 */
export function readOrderLineBundle(
  properties: string | readonly unknown[] | null | undefined,
  quantity: number,
): OrderLineBundle | null {
  const entry = frozenEntries(properties).find((candidate) => isRecord(candidate) && candidate.key === LINE_BUNDLE_PROPERTY_KEY);
  if (!isRecord(entry) || typeof entry.value !== "string" || !isRecord(entry.bundle)) return null;
  const { id, kind, anchor, units, perUnit } = entry.bundle;
  if (typeof id !== "string" || id.length === 0 || id.length > 128 || typeof anchor !== "boolean") return null;
  if (kind === "merge") return { id, title: entry.value, kind, anchor, units: null, perUnit: null };
  if (kind !== "expand" || !positiveCount(units) || !positiveCount(perUnit)) return null;
  const whole = units * perUnit === quantity;
  return { id, title: entry.value, kind, anchor, units: whole ? units : null, perUnit: whole ? perUnit : null };
}

/**
 * Whether a frozen entry is something the buyer entered (the product's own
 * input or an app's line input), not a fact the platform froze beside them:
 * an add-on, a purchase option, a bundle, a gift card's recipient.
 */
export function isLineInputEntry(key: string): boolean {
  return key !== LINE_ADJUSTMENT_PROPERTY_KEY && key !== LINE_PURCHASE_OPTION_PROPERTY_KEY
    && key !== LINE_BUNDLE_PROPERTY_KEY && !key.startsWith(RESERVED_PROPERTY_KEY_PREFIX);
}

/** The frozen entries of an order line, as stored: `[]` for none or a malformed column. */
export function readOrderLineProperties(properties: string | readonly unknown[] | null | undefined): ResolvedLineProperty[] {
  const resolved: ResolvedLineProperty[] = [];
  for (const entry of frozenEntries(properties)) {
    if (
      !isRecord(entry) || typeof entry.key !== "string" || typeof entry.label !== "string"
      || typeof entry.value !== "string" || typeof entry.displayValue !== "string"
      || typeof entry.priceMinor !== "number" || !Number.isSafeInteger(entry.priceMinor)
      || !(LINE_INPUT_FIELD_TYPES as readonly unknown[]).includes(entry.type)
    ) continue;
    resolved.push({
      key: entry.key,
      type: entry.type as LineInputFieldType,
      label: entry.label,
      value: entry.value,
      displayValue: entry.displayValue,
      priceMinor: entry.priceMinor,
      ...(typeof entry.appId === "string" && entry.appId ? { appId: entry.appId } : {}),
      ...(typeof entry.textRevision === "string" && LINE_PROPERTY_REVISION_PATTERN.test(entry.textRevision) ? { textRevision: entry.textRevision } : {}),
      ...(typeof entry.revision === "string" && LINE_PROPERTY_REVISION_PATTERN.test(entry.revision) ? { revision: entry.revision } : {}),
      ...(isRecord(entry.confirmation) && typeof entry.confirmation.text === "string" ? { confirmation: { text: entry.confirmation.text } } : {}),
    });
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// App line inputs (manifest `checkout.lineInputs`)
// ---------------------------------------------------------------------------

/** One app line input as a manifest declares it (buyer-ui.ts `lineInputDeclarationSchema`). */
export interface AppLineInputDeclaration {
  key: string;
  label: string;
  help?: string;
  type: LineInputFieldType;
  maxLength?: number;
  options?: ReadonlyArray<{ value: string; label: string; confirm?: LineInputConfirm }>;
  /** Cart-wide apply and clear actions the host draws. */
  bulk?: LineInputBulk;
  /** `file`: the types, size and count it takes (`withBuyerUploadBounds` applies the plan's bounds). */
  accept?: readonly BuyerUploadType[];
  maxBytes?: number;
  maxFiles?: number;
  /**
   * The revision of its words as the buyer sees them (`lineInputTextRevision`),
   * set when the merchant may edit them (a `labelSetting`, `helpSetting` or
   * choice `labelSetting`) or a choice needs confirmation: an answer records
   * the revision it was given under (`LinePropertyInput.revision`), so the
   * app can refuse an answer given to older words (a decline of an agreement
   * since changed), and checkout takes a choice that needs confirmation only
   * at the current revision.
   */
  textRevision?: string;
  /**
   * Checkout needs an answer on every line the input applies to: present
   * only while the requirement is on (the manifest's `decision`, with its
   * `requiredSetting` read). `proceedWith` is the choice, one that needs
   * confirmation, the host sets on every undecided line once the buyer
   * agrees to it at Place order.
   */
  decision?: { proceedWith?: string };
  /** Shown on products whose app flag (a storefront-visible boolean product field) is true. */
  products?: AppLineInputGate;
  /**
   * Shown on SKUs whose app flag (a storefront-visible boolean variant field)
   * is true. With `products` too, a SKU's own value (true or false) decides
   * and an unset SKU follows its product's.
   */
  variants?: AppLineInputGate;
}

/**
 * The revision of a line input's words as the buyer sees them (label, help,
 * option labels and each choice's confirmation: its agreement, title and
 * tick-box words): sha256 of their canonical JSON, 16 hex.
 */
export function lineInputTextRevision(input: Pick<AppLineInputDeclaration, "label" | "help" | "options">): string {
  const options = (input.options ?? []).map((option) => {
    const confirm = (option as { confirm?: LineInputConfirm }).confirm;
    return [option.value, option.label, confirm ? [confirm.text, confirm.title ?? null, confirm.agree ?? null] : null];
  });
  return sha256HexSync(JSON.stringify([input.label, input.help ?? null, options])).slice(0, 16);
}

/**
 * Answers given now, to the words `schema` draws: each answer to an input
 * whose words the merchant writes names their revision (`revision`), as the
 * buy form sends it. Other answers are unchanged.
 */
export function withAnswerRevisions<T extends LinePropertyInput>(schema: CustomizationSchema | null, answers: readonly T[]): T[] {
  const revisions = new Map((schema?.fields ?? []).flatMap((field) => (field.textRevision ? [[field.key, field.textRevision] as const] : [])));
  return answers.map((answer) => {
    const revision = revisions.get(answer.key);
    return revision ? { ...answer, revision } : answer;
  });
}

/** The app's own boolean custom field a line input's showing follows. */
export interface AppLineInputGate {
  customField: string;
}

/**
 * An owner's app flags: `<app id>.<field key>` → the boolean set on it
 * (absent: unset). Read from the product's or SKU's storefront custom fields.
 */
export type AppLineInputFlags = ReadonlyMap<string, boolean>;

/**
 * Whether an app's line input applies to a line of this product and SKU, the
 * one rule the buy form, the island, quick checkout and the server share:
 * - no gate: every line;
 * - `products` only: the product's flag is true;
 * - `variants` only: the SKU's flag is true (no SKU chosen: not yet);
 * - both: the SKU's flag when it has one, else the product's.
 */
export function appLineInputApplies(
  appId: string,
  input: Pick<AppLineInputDeclaration, "products" | "variants">,
  flags: { product: AppLineInputFlags; variant: AppLineInputFlags | null },
): boolean {
  if (!input.products && !input.variants) return true;
  if (input.variants) {
    const own = flags.variant?.get(`${appId}.${input.variants.customField}`);
    if (own !== undefined) return own;
    if (!input.products) return false;
  }
  return flags.product.get(`${appId}.${input.products!.customField}`) === true;
}

/**
 * The SKUs among `variants` an app's input applies to (`appLineInputApplies`
 * over the product's and each SKU's flags): null when it applies to every
 * one, or names no SKU flag and applies to the product; [] when to none. The
 * storefront's buy form and the staff order form show a gated input by it.
 */
export function appLineInputVariantIds(
  appId: string,
  input: Pick<AppLineInputDeclaration, "products" | "variants">,
  product: AppLineInputFlags,
  variants: ReadonlyArray<{ id: string; flags: AppLineInputFlags }>,
): string[] | null {
  if (!input.variants) return appLineInputApplies(appId, input, { product, variant: null }) ? null : [];
  const ids = variants.filter((variant) => appLineInputApplies(appId, input, { product, variant: variant.flags })).map((variant) => variant.id);
  return ids.length === variants.length && ids.length > 0 ? null : ids;
}

/**
 * Flags from the checkout reads' `appFlags` column: a JSON list of
 * `<app id>.<key>=true|false` (one per boolean app field the owner has a
 * value for). Anything else reads as no flags.
 */
export function parseAppLineInputFlags(value: unknown): AppLineInputFlags {
  const flags = new Map<string, boolean>();
  let list: unknown = value;
  if (typeof value === "string") {
    try {
      list = JSON.parse(value);
    } catch {
      return flags;
    }
  }
  if (!Array.isArray(list)) return flags;
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const at = entry.lastIndexOf("=");
    if (at <= 0) continue;
    const state = entry.slice(at + 1);
    if (state === "true" || state === "false") flags.set(entry.slice(0, at), state === "true");
  }
  return flags;
}

/** An active app's line inputs. */
export interface AppLineInputs {
  appId: string;
  inputs: readonly AppLineInputDeclaration[];
}

/**
 * The fields a product's buy form and checkout resolve a line against: the
 * merchant's schema, then every app's line inputs, apps by id, each in its
 * declared order, under `<app id>.<key>` and priced at nothing (an app adds
 * to the line with `cart.line_prices` adjustments). The order is part of
 * the line's identity, so the product page and checkout build it the same
 * way. An app input is never required (the app's `cart.validate` asks for
 * a missing one). `shown` decides an input limited to some products or
 * SKUs (`products`, `variants`; `appLineInputApplies` over the line's
 * product and SKU flags): the product page, the island, quick checkout and
 * checkout itself pass it, so an input on a line it does not apply to is
 * refused as unknown. Gift cards take no app inputs: callers leave them out.
 */
export function withAppLineInputs(
  schema: CustomizationSchema | null,
  apps: readonly AppLineInputs[],
  shown: (appId: string, input: AppLineInputDeclaration) => boolean,
): CustomizationSchema | null {
  const fields: CustomizationField[] = [];
  for (const app of [...apps].sort((left, right) => (left.appId < right.appId ? -1 : left.appId > right.appId ? 1 : 0))) {
    for (const input of app.inputs) {
      if ((input.products || input.variants) && !shown(app.appId, input)) continue;
      const base = { key: appScopedKey(app.appId, input.key), label: input.label, required: false, help: input.help ?? null, appId: app.appId, ...(input.textRevision ? { textRevision: input.textRevision } : {}) };
      if (input.type === "select") {
        fields.push({ ...base, type: "select", options: (input.options ?? []).map((option) => ({ value: option.value, label: option.label, priceMinor: 0, ...(option.confirm ? { confirm: option.confirm } : {}) })) });
      } else if (input.type === "checkbox") {
        fields.push({ ...base, type: "checkbox", priceMinor: 0 });
      } else if (input.type === "file") {
        fields.push({
          ...base,
          type: "file",
          accept: input.accept?.length ? [...input.accept] : [...BUYER_UPLOAD_TYPES],
          maxBytes: Math.min(input.maxBytes ?? BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes, BUYER_UPLOAD_DECLARATION_LIMITS.maxBytes),
          maxFiles: Math.min(input.maxFiles ?? 1, BUYER_UPLOAD_DECLARATION_LIMITS.maxFiles),
          priceMinor: 0,
        });
      } else {
        const limit = input.type === "text" ? CUSTOMIZATION_LIMITS.textMaxLength : CUSTOMIZATION_LIMITS.textareaMaxLength;
        fields.push({ ...base, type: input.type, maxLength: Math.min(input.maxLength ?? limit, limit), priceMinor: 0 });
      }
    }
  }
  if (fields.length === 0) return schema;
  return { version: CUSTOMIZATION_SCHEMA_VERSION, fields: [...(schema?.fields ?? []), ...fields] };
}

/**
 * The properties one app may see of a line (`line.properties` in its
 * functions): the merchant's inputs and its own line inputs, never another
 * app's, as checkout attributes are kept.
 */
export function appVisibleLineProperties<T extends { key: string }>(properties: readonly T[], appId: string): T[] {
  return properties.filter((property) => {
    const owner = appScopedKeyAppId(property.key);
    return owner === null || owner === appId;
  });
}

/** The frozen `order_items.properties` entry. */
export interface ResolvedLineProperty {
  key: string;
  type: LineInputFieldType;
  label: string;
  value: string;
  /** What to print after the label: the option label for selects, "Yes" for ticked boxes, "2 files" for uploads. */
  displayValue: string;
  priceMinor: number;
  /** The app the entry belongs to: its line input, add-on or purchase option. Absent for the merchant's inputs. */
  appId?: string;
  /**
   * An app input whose words the merchant writes: the revision of the words
   * frozen with it (`label`, as checkout showed them).
   */
  textRevision?: string;
  /**
   * The revision of the words the buyer answered (`LinePropertyInput.revision`):
   * equal to `textRevision` unless the answer was given to older words and
   * the app accepted it. Absent when the answer named none.
   */
  revision?: string;
  /** A choice that needs confirmation: the agreement the buyer accepted, as shown. */
  confirmation?: { text: string };
}

/**
 * Why a line's inputs are refused: a required one is missing, one is unknown
 * or malformed, or a choice that needs confirmation was not agreed to at the
 * words shown now (no revision, or an older one: the agreement changed since
 * the buyer agreed), so the buyer must read and agree again.
 */
export const LINE_PROPERTY_ISSUE_CODES = ["properties_required", "properties_invalid", "confirmation_required"] as const;
export type LinePropertyIssueCode = (typeof LINE_PROPERTY_ISSUE_CODES)[number];

export type ResolveLinePropertiesResult =
  | {
      ok: true;
      canonical: CanonicalLineProperty[];
      properties: ResolvedLineProperty[];
      /** Sum of the surcharges; the line's unit price is base + this. */
      propertiesPriceMinor: number;
    }
  | { ok: false; code: LinePropertyIssueCode; key: string | null; reason: string };

const CHECKBOX_TICKED = "true";
const CHECKBOX_DISPLAY = LINE_ENTRY_WORDS_EN.lineCheckedText;

function inputEntries(input: unknown): unknown[] {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}

function fieldValue(field: CustomizationField, raw: string): string | null {
  const value = normalizePropertyText(raw);
  if (!value) return null;
  if (field.type === "checkbox") return value === CHECKBOX_TICKED ? value : null;
  if (field.type === "file") {
    const ids = parseBuyerUploadValue(value, field.maxFiles);
    return ids ? formatBuyerUploadValue(ids) : value;
  }
  return value;
}

/**
 * The canonical properties used for the cart line key (P2): only schema keys,
 * NFC-normalized and trimmed, empty optional fields dropped, in schema order.
 * Lenient on purpose; `resolveLineProperties` is the strict check.
 */
export function canonicalizeLineProperties(
  schema: CustomizationSchema | null,
  input: unknown,
): CanonicalLineProperty[] {
  if (!schema) return [];
  const byKey = new Map<string, { value: string; revision?: string }>();
  for (const entry of inputEntries(input)) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") continue;
    if (!byKey.has(entry.key)) byKey.set(entry.key, { value: entry.value, ...(answerRevision(entry.revision) ? { revision: entry.revision as string } : {}) });
  }
  const canonical: CanonicalLineProperty[] = [];
  for (const field of schema.fields) {
    const raw = byKey.get(field.key);
    if (raw === undefined) continue;
    const value = fieldValue(field, raw.value);
    // The revision rides beside the answer, never in its identity (`linePropertiesHash` reads key and value).
    if (value !== null) canonical.push({ key: field.key, value, ...(raw.revision && field.textRevision ? { revision: raw.revision } : {}) });
  }
  return canonical;
}


/** The option of a select answer that needs the buyer's confirmation, or null. */
export function lineInputConfirmOption(field: CustomizationField, value: string): (CustomizationSelectOption & { confirm: LineInputConfirm }) | null {
  if (field.type !== "select") return null;
  const option = field.options.find((choice) => choice.value === value);
  return option?.confirm ? option as CustomizationSelectOption & { confirm: LineInputConfirm } : null;
}

function invalid(key: string | null, reason: string): ResolveLinePropertiesResult {
  return { ok: false, code: "properties_invalid", key, reason };
}

/** Why a field's value is refused, by kind: `too_long` carries the field's limit. */
export type LineInputProblem =
  | { kind: "required" }
  | { kind: "too_long"; maxLength: number }
  | { kind: "invalid" };

/**
 * The one rule for a filled, normalized value of one field: within its
 * limit, one line for text, "true" for a ticked box, one of the choices.
 * `resolveLineProperties` (the server, the checkout, the order form) and
 * `lineInputIssues` (every form that shows the buyer's fields) share it.
 */
function fieldValueProblem(
  field: CustomizationField,
  value: string,
): (Exclude<LineInputProblem, { kind: "required" }> & { reason: string }) | null {
  switch (field.type) {
    case "text":
    case "textarea":
      if (characterLength(value) > field.maxLength) {
        return { kind: "too_long", maxLength: field.maxLength, reason: `at most ${field.maxLength} characters` };
      }
      if (hasControlCharacter(value) || (field.type === "text" && LINE_BREAKS.test(value))) {
        return { kind: "invalid", reason: "contains characters that are not allowed" };
      }
      return null;
    case "checkbox":
      return value === CHECKBOX_TICKED ? null : { kind: "invalid", reason: "a ticked box sends \"true\"" };
    case "select":
      return field.options.some((option) => option.value === value) ? null : { kind: "invalid", reason: "not one of the choices" };
    case "file":
      return parseBuyerUploadValue(value, field.maxFiles)
        ? null
        : { kind: "invalid", reason: `upload ids, at most ${field.maxFiles}` };
  }
}

/** One field's problem, for a message under that field. */
export interface LineInputIssue {
  key: string;
  problem: LineInputProblem;
}

/**
 * Every field the buyer must fix, in schema order (so the first is focused):
 * a missing required value, a value over its limit, or one the field does
 * not accept. Values are read as forms hold them (`""` or absent: empty; a
 * checkbox: "true" when ticked). Exactly what `resolveLineProperties`
 * refuses, field by field: the storefront's buyer-inputs block, the product
 * editor's preview and the order form all show these.
 */
export function lineInputIssues(
  schema: CustomizationSchema | null,
  values: readonly LinePropertyInput[],
): LineInputIssue[] {
  if (!schema) return [];
  const byKey = new Map<string, string>();
  for (const entry of values) if (!byKey.has(entry.key)) byKey.set(entry.key, entry.value);
  const issues: LineInputIssue[] = [];
  for (const field of schema.fields) {
    const value = normalizePropertyText(byKey.get(field.key) ?? "");
    if (!value) {
      if (field.required) issues.push({ key: field.key, problem: { kind: "required" } });
      continue;
    }
    const problem = fieldValueProblem(field, value);
    if (problem) issues.push({ key: field.key, problem: problem.kind === "too_long" ? { kind: "too_long", maxLength: problem.maxLength } : { kind: problem.kind } });
  }
  return issues;
}

/**
 * The count under a text field, as typed: Unicode characters of the NFC text
 * (the limit itself is checked on the trimmed text). The storefront and the
 * dashboard show the same number.
 */
export function lineInputLength(value: string): number {
  return characterLength(value.normalize("NFC"));
}

/**
 * Validate a line's properties against the product schema and price them
 * (§3.3). Runs in cart validation and again in the commit, against the
 * authority read's product row.
 */
export function resolveLineProperties(
  schema: CustomizationSchema | null,
  input: unknown,
): ResolveLinePropertiesResult {
  if (input !== undefined && input !== null && !Array.isArray(input)) {
    return invalid(null, "properties must be a list");
  }
  const entries = inputEntries(input);
  if (entries.length > LINE_PROPERTY_INPUT_LIMITS.entries) {
    return invalid(null, `at most ${LINE_PROPERTY_INPUT_LIMITS.entries} properties`);
  }
  const fields = new Map((schema?.fields ?? []).map((field) => [field.key, field]));
  const values = new Map<string, string>();
  // The revision each answer was given to, kept for inputs whose words the merchant writes.
  const revisions = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      return invalid(null, "each property is a text key and a text value");
    }
    const field = fields.get(entry.key);
    if (!field) return invalid(entry.key, "unknown property");
    if (values.has(entry.key)) return invalid(entry.key, "property sent twice");
    if (characterLength(entry.value) > LINE_PROPERTY_INPUT_LIMITS.valueLength) {
      return invalid(entry.key, `at most ${LINE_PROPERTY_INPUT_LIMITS.valueLength} characters`);
    }
    const value = normalizePropertyText(entry.value);
    if (!value) continue;
    const problem = fieldValueProblem(field, value);
    if (problem) return invalid(entry.key, problem.reason);
    values.set(entry.key, fieldValue(field, value)!);
    if (entry.revision !== undefined && entry.revision !== null) {
      if (typeof entry.revision !== "string" || !LINE_PROPERTY_REVISION_PATTERN.test(entry.revision)) return invalid(entry.key, "a malformed revision");
      if (field.textRevision) revisions.set(entry.key, entry.revision);
    }
    // A choice that needs confirmation is taken only with the agreement shown now:
    // a missing or older revision asks the buyer again.
    if (lineInputConfirmOption(field, value) && revisions.get(entry.key) !== field.textRevision) {
      return { ok: false, code: "confirmation_required", key: entry.key, reason: "needs the buyer's agreement to the words shown now" };
    }
  }

  const canonical: CanonicalLineProperty[] = [];
  const properties: ResolvedLineProperty[] = [];
  let propertiesPriceMinor = 0;
  for (const field of schema?.fields ?? []) {
    const value = values.get(field.key);
    if (value === undefined) {
      if (field.required) {
        return { ok: false, code: "properties_required", key: field.key, reason: "required" };
      }
      continue;
    }
    const option = field.type === "select"
      ? field.options.find((choice) => choice.value === value)!
      : null;
    const priceMinor = option ? option.priceMinor : (field as Exclude<CustomizationField, CustomizationSelectField>).priceMinor;
    const displayValue = option
      ? option.label
      : field.type === "checkbox"
        ? CHECKBOX_DISPLAY
        : field.type === "file"
          ? buyerUploadDisplayValue(parseBuyerUploadValue(value, field.maxFiles)!.length)
          : value;
    canonical.push({ key: field.key, value });
    const revision = revisions.get(field.key);
    const confirm = lineInputConfirmOption(field, value)?.confirm;
    properties.push({
      key: field.key, type: field.type, label: field.label, value, displayValue, priceMinor,
      ...(field.appId ? { appId: field.appId } : {}),
      ...(field.textRevision ? { textRevision: field.textRevision, ...(revision ? { revision } : {}) } : {}),
      ...(confirm ? { confirmation: { text: confirm.text } } : {}),
    });
    propertiesPriceMinor += priceMinor;
  }
  if (JSON.stringify(properties).length > LINE_PROPERTY_INPUT_LIMITS.serializedLength) {
    return invalid(null, "the answers on this line are too long together");
  }
  return { ok: true, canonical, properties, propertiesPriceMinor };
}

/** The `order_items.properties` column value: null without properties. */
export function serializeOrderLineProperties(properties: readonly ResolvedLineProperty[]): string | null {
  if (properties.length === 0) return null;
  const serialized = JSON.stringify(properties);
  if (serialized.length > ORDER_LINE_PROPERTIES_MAX_LENGTH) {
    throw new Error("Order line properties exceed the stored snapshot bound.");
  }
  return serialized;
}

/**
 * The schema with every surcharge passed through `convert` (MARKETS-DESIGN
 * step 6: a shop-currency surcharge in a market's currency, converted at its
 * rate and rounded to its increment). The product page and checkout convert
 * each surcharge the same way, so the buyer pays what the page showed. Zero
 * stays zero; a null schema stays null.
 */
export function mapCustomizationPrices(
  schema: CustomizationSchema | null,
  convert: (priceMinor: number) => number,
): CustomizationSchema | null {
  if (!schema) return schema;
  const price = (minor: number) => (minor === 0 ? 0 : convert(minor));
  return {
    ...schema,
    fields: schema.fields.map((field): CustomizationField => field.type === "select"
      ? { ...field, options: field.options.map((option) => ({ ...option, priceMinor: price(option.priceMinor) })) }
      : field.type === "file"
        ? field
        : { ...field, priceMinor: price(field.priceMinor) }),
  };
}
