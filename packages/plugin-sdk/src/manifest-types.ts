// Types read from an app's manifest (types only; nothing here runs). Declare
// the manifest with `defineManifest({ … })` and `definePlugin` types
// `ctx.objects.<name>` records and `ctx.settings` by the fields it declares;
// `StorefrontSettingsOf` types a storefront component's settings. Only a
// `defineManifest` manifest (branded, with its literal types kept) opts in:
// a manifest written inline or with `satisfies PluginManifestInput` keeps the
// loose types, so every existing app compiles unchanged.

import type { PluginManifestInput, PluginSettingValue } from "@scalius/shared/plugins";
import type { StorefrontImage, StorefrontProductCard, StorefrontResolvedSettings } from "@scalius/shared/plugins/storefront-protocol";
import type { PluginContext, PluginMoney, PluginObjectCollection, PluginObjects } from "./context";

type Manifest = PluginManifestInput;

/** Marks a manifest from `defineManifest` (type only: no such property exists at runtime). */
declare const DEFINED_MANIFEST: unique symbol;
/** A manifest from `defineManifest`: its own literal type, branded so `definePlugin` types handlers by it. */
export type DefinedManifest<M> = M & { readonly [DEFINED_MANIFEST]?: true };
type IsDefined<M> = typeof DEFINED_MANIFEST extends keyof M ? true : false;
type Values<T> = T extends readonly (infer U)[] ? U : never;
/** True for a literal string (`"notes"`), false for `string`. */
type IsLiteral<K> = K extends string ? (string extends K ? false : true) : false;

// ── Objects ──────────────────────────────────────────────────────────────

/** A record field's value as `ctx.objects` reads and writes it (money as `PluginMoney`, integer minor units). */
export type ObjectFieldValue<Type> =
  Type extends `list.${infer Item}` ? Array<ObjectFieldValue<Item>>
    : Type extends "integer" | "decimal" ? number
      : Type extends "boolean" ? boolean
        : Type extends "json" ? unknown
          : Type extends "money" ? PluginMoney
            : Type extends string ? string
              : unknown;

type FieldOf<O> = O extends { fields?: infer F } ? Values<F> : never;
type RequiredKeys<F> = F extends { key: infer K extends string; required: true } ? K : never;
type OptionalKeys<F> = F extends { key: infer K extends string } ? (F extends { required: true } ? never : K) : never;
type FieldType<F, K> = F extends { key: K; type: infer T } ? ObjectFieldValue<T> : never;

/** One object type's record, from its declared fields (required fields present, others optional or null). */
export type ObjectRecordOf<O> =
  IsLiteral<FieldOf<O> extends { key: infer K } ? K : string> extends true
    ? { [K in RequiredKeys<FieldOf<O>>]: FieldType<FieldOf<O>, K> } & { [K in OptionalKeys<FieldOf<O>>]?: FieldType<FieldOf<O>, K> | null }
    : Record<string, unknown>;

type ObjectsOf<M> = M extends { objects?: infer O } ? NonNullable<O> : never;

/** `ctx.objects` for a manifest: each declared object by name with its record type, then the loose map (`batch`, other names). */
export type PluginObjectsOf<M> =
  [ObjectsOf<M>] extends [never] ? PluginObjects
    : string extends keyof ObjectsOf<M> ? PluginObjects
      : { readonly [Name in keyof ObjectsOf<M>]: PluginObjectCollection<ObjectRecordOf<ObjectsOf<M>[Name]>> } & PluginObjects;

// ── Settings ─────────────────────────────────────────────────────────────

type OptionValue<F> = F extends { options: infer O } ? (Values<O> extends { value: infer V } ? V : string) : string;

/** A setting's value by its field type (`select` and `multiselect` as their option values). */
export type SettingValueOf<F> =
  F extends { type: "number" } ? number
    : F extends { type: "boolean" } ? boolean
      : F extends { type: "select" } ? OptionValue<F>
        : F extends { type: "multiselect" } ? Array<OptionValue<F>>
          : F extends { type: "image" } ? StorefrontImage | null
            : F extends { type: "product" } ? StorefrontProductCard | null
              : F extends { type: "products" } ? StorefrontProductCard[]
                : F extends { type: "list"; fields: infer Items } ? Array<{ [I in Values<Items> as I extends { key: infer K extends string } ? K : never]: SettingItemValue<I> }>
                  : string;

type SettingItemValue<I> =
  I extends { type: "number" } ? number | null
    : I extends { type: "boolean" } ? boolean | null
      : I extends { type: "image" } ? StorefrontImage | null
        : string | null;

/** The groups a feature owns: their settings exist only while it is on. */
type FeatureGroups<M> = M extends { features?: infer F } ? (Values<NonNullable<F>> extends { settingsGroups?: infer G } ? Values<NonNullable<G>> : never) : never;
/** A setting is always there when it has a default and no feature can switch it off. */
type Always<F, M> = F extends { default: unknown } ? (F extends { group: FeatureGroups<M> } ? false : true) : false;

/** Settings by key from a settings array (`manifest.settings`, a section's or block's `settings`). */
export type SettingsOf<Fields, M = unknown> =
  IsLiteral<Values<Fields> extends { key: infer K } ? K : string> extends true
    ? {
      readonly [F in Values<Fields> as F extends { key: infer K extends string } ? (Always<F, M> extends true ? K : never) : never]: SettingValueOf<F>;
    } & {
      readonly [F in Values<Fields> as F extends { key: infer K extends string } ? (Always<F, M> extends true ? never : K) : never]?: SettingValueOf<F> | null;
    }
    : unknown;

/** `ctx.settings` (and a function's `settings`) for a manifest. */
export type PluginSettingsOf<M> = IsDefined<M> extends true
  ? (M extends { settings?: infer S } ? SettingsOf<NonNullable<S>, M> : unknown) & Readonly<Record<string, PluginSettingValue>>
  : Readonly<Record<string, PluginSettingValue>>;

/**
 * The context handlers of a manifest get: for a `defineManifest` manifest,
 * `PluginContext` with typed objects and settings (still assignable to
 * `PluginContext`); otherwise `PluginContext` itself.
 */
export type PluginContextOf<M> = IsDefined<M> extends true
  ? Omit<PluginContext, "objects" | "settings"> & { objects: PluginObjectsOf<M>; settings: PluginSettingsOf<M> }
  : PluginContext;

// ── Storefront ───────────────────────────────────────────────────────────

type StorefrontOf<M> = M extends { storefront?: infer S } ? NonNullable<S> : never;
type Declared<List, Id extends string, Key extends string> = Values<List> extends infer E ? (E extends { [P in Id]: Key } ? E : never) : never;
type SettingsOfEntry<E> = (E extends { settings?: infer S } ? SettingsOf<NonNullable<S>> : unknown) extends infer R ? (unknown extends R ? StorefrontResolvedSettings : R) : never;

/**
 * A storefront component's settings, from the manifest:
 * `SectionProps<StorefrontSettingsOf<typeof manifest, "section", "banner">>`
 * (`"component"` for a component type, `"skin"` for a skin id).
 */
export type StorefrontSettingsOf<M, Kind extends "section" | "component" | "skin", Key extends string> =
  Kind extends "section" ? SettingsOfEntry<Declared<StorefrontOf<M> extends { sections?: infer L } ? NonNullable<L> : never, "type", Key>>
    : Kind extends "component" ? SettingsOfEntry<Declared<StorefrontOf<M> extends { components?: infer L } ? NonNullable<L> : never, "type", Key>>
      : SettingsOfEntry<Declared<StorefrontOf<M> extends { skins?: infer L } ? NonNullable<L> : never, "id", Key>>;

/**
 * Declares a manifest with its literal types kept, so `definePlugin` can type
 * `ctx.objects` records and `ctx.settings` by key. A mistake is reported at
 * the key that is wrong (`placement: "buybox"` → Did you mean "buy-box"?), not
 * as a wall of structural types. Identity at runtime.
 */
export function defineManifest<const M extends Manifest>(manifest: M): DefinedManifest<M> {
  return manifest;
}
