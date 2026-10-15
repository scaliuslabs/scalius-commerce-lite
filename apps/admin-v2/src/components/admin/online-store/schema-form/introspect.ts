/**
 * What a settings form draws, read from the theme registry's strict zod
 * schemas (sections and block variants): text with its length limits,
 * numbers with their range, switches, choices (enums and literal unions),
 * groups, repeatable lists and discriminated variants. Reading the schema
 * keeps the dashboard in step with the contract: a new registry setting
 * gets a control without new form code, and the test that walks every
 * registry schema fails when a shape is one the form cannot draw.
 */

interface ZodInternals {
  _zod: { def: Record<string, unknown> & { type: string } };
}

/** The public length and range getters of a zod string or number schema (null or infinite when unset). */
interface Bounded {
  minLength?: number | null;
  maxLength?: number | null;
  minValue?: number | null;
  maxValue?: number | null;
  isInt?: boolean;
}

type Base = { optional?: boolean; nullable?: boolean };

export type TextSpec = Base & { kind: "text"; min: number; max: number | null };
export type NumberSpec = Base & { kind: "number"; min: number; max: number; int: boolean };
export type BooleanSpec = Base & { kind: "boolean" };
export type ChoiceSpec = Base & { kind: "choice"; values: ReadonlyArray<string | number> };
export type ObjectSpec = Base & { kind: "object"; fields: ReadonlyArray<SettingField> };
export type ListSpec = Base & { kind: "list"; item: SettingSpec; min: number; max: number | null };
export type VariantsSpec = Base & {
  kind: "variants";
  /** The discriminator key (`layout`, `kind`). */
  key: string;
  options: ReadonlyArray<{ value: string; spec: ObjectSpec }>;
};
export type SettingSpec = TextSpec | NumberSpec | BooleanSpec | ChoiceSpec | ObjectSpec | ListSpec | VariantsSpec;

export interface SettingField {
  key: string;
  spec: SettingSpec;
}

function internals(schema: unknown): ZodInternals["_zod"] {
  const zod = (schema as Partial<ZodInternals> | null)?._zod;
  if (!zod?.def) throw new Error("Not a zod schema");
  return zod;
}

/** The optional flag a hidden block carries (storefrontVisibleSection). */
const BLOCK_HIDDEN_KEY = "hidden";

const finite = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const bound = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** An array's item bounds, from its `min_length` and `max_length` checks (zod has no getter for them). */
function itemBounds(schema: unknown): { min: number; max: number | null } {
  const checks = (schema as { def: { checks?: Array<{ _zod: { def: { check: string; minimum?: number; maximum?: number } } }> } }).def.checks ?? [];
  const defs = checks.map((check) => check._zod.def);
  return {
    min: finite(defs.find((each) => each.check === "min_length")?.minimum, 0),
    max: bound(defs.find((each) => each.check === "max_length")?.maximum),
  };
}

function literalValue(schema: unknown): string | number {
  const { def } = internals(schema);
  if (def.type !== "literal") throw new Error(`Expected a literal, found ${def.type}`);
  const values = def.values as unknown[];
  const value = values[0];
  if (values.length !== 1 || (typeof value !== "string" && typeof value !== "number")) {
    throw new Error("Only single string or number literals are supported");
  }
  return value;
}

/** The spec of a zod schema. Throws on a shape the form cannot draw. */
export function describeSetting(schema: unknown): SettingSpec {
  const { def } = internals(schema);
  const bounded = schema as Bounded;
  switch (def.type) {
    case "optional":
      return { ...describeSetting(def.innerType), optional: true };
    case "nullable":
      return { ...describeSetting(def.innerType), nullable: true };
    case "default":
    case "prefault":
      return describeSetting(def.innerType);
    case "string":
      return { kind: "text", min: finite(bounded.minLength, 0), max: bound(bounded.maxLength) };
    case "number":
      return {
        kind: "number",
        min: finite(bounded.minValue, Number.MIN_SAFE_INTEGER),
        max: finite(bounded.maxValue, Number.MAX_SAFE_INTEGER),
        int: bounded.isInt === true,
      };
    case "boolean":
      return { kind: "boolean" };
    case "enum":
      return { kind: "choice", values: Object.values(def.entries as Record<string, string | number>) };
    case "literal":
      return { kind: "choice", values: [literalValue(schema)] };
    case "object": {
      const shape = def.shape as Record<string, unknown>;
      // A block's `hidden` is the editor's show/hide toggle in its tree, not a field.
      return {
        kind: "object",
        fields: Object.entries(shape).filter(([key]) => key !== BLOCK_HIDDEN_KEY && key !== "bindings").map(([key, value]) => ({ key, spec: describeSetting(value) })),
      };
    }
    case "array":
      return {
        kind: "list",
        item: describeSetting(def.element),
        ...itemBounds(schema),
      };
    case "union": {
      const options = def.options as unknown[];
      const key = def.discriminator;
      if (typeof key === "string") {
        return {
          kind: "variants",
          key,
          options: options.map((option) => {
            const spec = describeSetting(option);
            if (spec.kind !== "object") throw new Error("Variants must be objects");
            const shape = internals(option).def.shape as Record<string, unknown>;
            return { value: String(literalValue(shape[key])), spec };
          }),
        };
      }
      return { kind: "choice", values: options.map(literalValue) };
    }
    default:
      throw new Error(`Unsupported setting schema: ${def.type}`);
  }
}

/** A new value for a spec: empty text, the lowest number, the first choice, the shortest list. */
export function settingDefault(spec: SettingSpec): unknown {
  if (spec.nullable) return null;
  switch (spec.kind) {
    case "text":
      return "";
    case "number":
      return spec.min;
    case "boolean":
      return false;
    case "choice":
      return spec.values[0];
    case "object":
      return Object.fromEntries(spec.fields
        .filter((field) => !field.spec.optional)
        .map((field) => [field.key, settingDefault(field.spec)]));
    case "list":
      return Array.from({ length: spec.min }, () => settingDefault({ ...spec.item, nullable: false }));
    case "variants":
      return settingDefault(spec.options[0]!.spec);
  }
}

/** The variant a value is (its discriminator), or the first one. */
export function variantOf(spec: VariantsSpec, value: unknown): VariantsSpec["options"][number] {
  const current = (value as Record<string, unknown> | null)?.[spec.key];
  return spec.options.find((option) => option.value === current) ?? spec.options[0]!;
}

/**
 * Another variant at its defaults, keeping every setting both variants
 * declare with the same kind (an editorial's heading and body when it
 * becomes image-with-text), as storefrontBlockSwitch does for blocks.
 */
export function switchVariant(spec: VariantsSpec, value: unknown, next: string): Record<string, unknown> {
  const target = spec.options.find((option) => option.value === next);
  if (!target) throw new Error(`Unknown variant ${next}`);
  const current = variantOf(spec, value);
  const result = settingDefault(target.spec) as Record<string, unknown>;
  const from = (value ?? {}) as Record<string, unknown>;
  for (const field of target.spec.fields) {
    if (field.key === spec.key) continue;
    const before = current.spec.fields.find((each) => each.key === field.key);
    if (before && before.spec.kind === field.spec.kind && from[field.key] !== undefined) {
      result[field.key] = from[field.key];
    }
  }
  return result;
}
