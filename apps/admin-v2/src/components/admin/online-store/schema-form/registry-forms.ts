/**
 * The settings forms the theme registry defines: one per section type and
 * one per block variant that has settings, each with its label scope.
 */
import {
  STOREFRONT_BLOCK_SLOTS,
  STOREFRONT_SECTION_REGISTRY,
  STOREFRONT_SECTION_TYPES,
  storefrontBlockVariants,
  storefrontVariantSpec,
  type StorefrontBlockSlot,
  type StorefrontSectionType,
} from "@scalius/shared/storefront-theme";
import { describeSetting, type ObjectSpec, type SettingSpec } from "./introspect";
import { blockLabelScope, sectionLabelScope, type LabelScope } from "./labels";

const cache = new Map<string, SettingSpec>();

function described(id: string, schema: unknown): SettingSpec {
  let spec = cache.get(id);
  if (!spec) {
    spec = describeSetting(schema);
    cache.set(id, spec);
  }
  return spec;
}

/** A section type's settings spec (an object, or variants for the editorial section). */
export function sectionSettingSpec(type: StorefrontSectionType): SettingSpec {
  return described(`section:${type}`, STOREFRONT_SECTION_REGISTRY[type].settings);
}

/** A block variant's settings spec (always an object; empty when the variant has none). */
export function blockSettingSpec(slot: StorefrontBlockSlot, variant: string): ObjectSpec {
  return described(`block:${slot}:${variant}`, storefrontVariantSpec(slot, variant).settings) as ObjectSpec;
}

/** True when a spec has something to edit. */
export function hasSettings(spec: SettingSpec): boolean {
  return spec.kind !== "object" || spec.fields.length > 0;
}

export interface RegistryForm {
  id: string;
  scope: LabelScope;
  spec: SettingSpec;
}

/** Every settings form in the registry (for coverage tests). */
export function registryForms(): RegistryForm[] {
  return [
    ...STOREFRONT_SECTION_TYPES.map((type) => ({ id: `section:${type}`, scope: sectionLabelScope(type), spec: sectionSettingSpec(type) })),
    ...STOREFRONT_BLOCK_SLOTS.flatMap((slot) => storefrontBlockVariants(slot)
      .map((variant) => ({ id: `block:${slot}:${variant}`, scope: blockLabelScope(slot, variant), spec: blockSettingSpec(slot, variant) }))
      .filter((form) => hasSettings(form.spec))),
  ];
}
