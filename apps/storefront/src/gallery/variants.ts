/**
 * Setting variants read from the registry's own schemas, so a new option
 * value in `@scalius/shared/storefront-theme` becomes a gallery entry with
 * no gallery change: every enum value, both booleans and every literal of a
 * literal union, one setting at a time over a base. Discriminated unions
 * (a product source, an editorial layout) need content, so the section's
 * fixture content lists their options (`section-content.ts`).
 */
/** A Zod schema as far as this file reads it (the storefront does not depend on zod itself). */
export interface SettingsSchema {
  safeParse(value: unknown): { success: boolean };
}

interface SchemaDef {
  type: string;
  innerType?: SettingsSchema;
  shape?: Record<string, SettingsSchema>;
  entries?: Record<string, string | number>;
  options?: SettingsSchema[];
  values?: unknown[];
  discriminator?: string;
}

function def(schema: SettingsSchema): SchemaDef {
  return (schema as unknown as { _zod: { def: SchemaDef } })._zod.def;
}

/** The schema under optional, nullable, default, readonly and catch wrappers. */
function unwrap(schema: SettingsSchema): SettingsSchema {
  let current = schema;
  for (;;) {
    const inner = def(current);
    if (["optional", "nullable", "default", "readonly", "catch", "nonoptional", "prefault"].includes(inner.type) && inner.innerType) {
      current = inner.innerType;
      continue;
    }
    return current;
  }
}

/** The values one leaf setting can take, or null when it is not a closed choice. */
function choices(schema: SettingsSchema): unknown[] | null {
  const leaf = def(unwrap(schema));
  if (leaf.type === "enum" && leaf.entries) return Object.values(leaf.entries);
  if (leaf.type === "boolean") return [true, false];
  if (leaf.type === "literal" && leaf.values) return leaf.values;
  if (leaf.type === "union" && !leaf.discriminator && leaf.options?.every((option) => def(option).type === "literal")) {
    return leaf.options.flatMap((option) => def(option).values ?? []);
  }
  return null;
}

export interface SettingChoice {
  /** Dotted path from the settings root (`filters.style`). */
  path: string;
  values: unknown[];
}

/** Every closed-choice setting of an object schema, depth first (nested objects too). */
export function settingChoices(schema: SettingsSchema, prefix = ""): SettingChoice[] {
  const root = def(unwrap(schema));
  if (root.type !== "object" || !root.shape) return [];
  return Object.entries(root.shape).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    const values = choices(child);
    if (values) return [{ path, values }];
    const inner = def(unwrap(child));
    return inner.type === "object" ? settingChoices(child, path) : [];
  });
}

export function settingAt(settings: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined), settings);
}

export function settingWith<Settings>(settings: Settings, path: string, value: unknown): Settings {
  const next = structuredClone(settings) as Record<string, unknown>;
  const keys = path.split(".");
  let target = next;
  for (const key of keys.slice(0, -1)) {
    target[key] = { ...((target[key] as Record<string, unknown> | undefined) ?? {}) };
    target = target[key] as Record<string, unknown>;
  }
  target[keys.at(-1)!] = value;
  return next as Settings;
}

export interface SettingVariant<Settings> {
  /** `path=value`, or "default" for the base. */
  label: string;
  settings: Settings;
}

/**
 * The base plus one variant per other value of each closed-choice setting
 * the schema accepts over that base (a value the schema refuses there, such
 * as open dropdown filters, is left out).
 */
export function settingVariants<Settings>(schema: SettingsSchema, base: Settings): Array<SettingVariant<Settings>> {
  const variants: Array<SettingVariant<Settings>> = [{ label: "default", settings: base }];
  const seen = new Set([JSON.stringify(base)]);
  for (const { path, values } of settingChoices(schema)) {
    for (const value of values) {
      const settings = settingWith(base, path, value);
      const key = JSON.stringify(settings);
      if (seen.has(key) || !schema.safeParse(settings).success) continue;
      seen.add(key);
      variants.push({ label: `${path}=${String(value)}`, settings });
    }
  }
  return variants;
}
