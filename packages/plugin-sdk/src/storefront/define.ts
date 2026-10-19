// `defineStorefront`: an app's storefront module. It maps the manifest's
// component sections, component product blocks and skins to components and
// answers the storefront's render batches (the protocol in
// @scalius/shared/plugins/storefront-protocol). Each job renders alone: a
// component that throws fails only its own job, and the storefront then draws
// nothing there (a section or block) or the core unit (a skin).

import {
  STOREFRONT_COMPONENT_ABI,
  type StorefrontBlockTarget,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontListingPage,
  type StorefrontModule,
  type StorefrontProductCardData,
  type StorefrontProductPage,
  type StorefrontRenderBatch,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  type StorefrontRenderReply,
  type StorefrontResolvedSettings,
  type StorefrontSectionSkinData,
  type StorefrontSectionSkinSettings,
  type StorefrontSkinnableSection,
} from "@scalius/shared/plugins/storefront-protocol";
import { toHtml, type Renderable } from "./html";

export interface SectionProps<Settings = StorefrontResolvedSettings> {
  objects: NonNullable<Extract<StorefrontRenderJob, { kind: "section" }>["objects"]>;
  settings: Settings;
  /** The theme's id of this placement (stable while the merchant keeps it). */
  instanceId: string;
  context: StorefrontRenderContext;
}

/** What a skin gets: the merchant's values for its settings and its unit's projection. */
export interface SkinProps<Data, Settings = StorefrontResolvedSettings> {
  settings: Settings;
  data: Data;
  context: StorefrontRenderContext;
}

export type HeaderProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontHeaderData, Settings>;
export type FooterProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontFooterData, Settings>;
export type ProductCardProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontProductCardData, Settings>;
/** A product-main skin: place the store's buy form with `<BuyForm />` (exactly one; without it core draws the page). */
export type ProductMainProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontProductPage, Settings>;
/** A listing-main skin: `<Filters />`, `<Toolbar />` and `<Pagination />` place the store's own (pagination is appended when left out). */
export type ListingMainProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontListingPage, Settings>;
/** A core section's skin (`section:<type>`): the section's sealed projection (`StorefrontSectionSkinSettings[type]`). */
export type SectionSkinProps<Type extends StorefrontSkinnableSection = StorefrontSkinnableSection, Settings = StorefrontResolvedSettings> =
  SkinProps<StorefrontSectionSkinData<StorefrontSectionSkinSettings[Type]>, Settings> & {
    /** The theme's id of the section placement. */
    instanceId: string;
  };

/** A component product block: the product page's projection and where it draws. */
export interface BlockProps<Settings = StorefrontResolvedSettings> {
  settings: Settings;
  data: StorefrontProductPage;
  target: StorefrontBlockTarget;
  /** The theme's id of this placement. */
  instanceId: string;
  context: StorefrontRenderContext;
}

// Components take their own settings shapes; the module map is checked by
// the manifest at pack time, so the map itself is loosely typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type SectionComponent = (props: SectionProps<any>) => Renderable;
export type HeaderComponent = (props: HeaderProps<any>) => Renderable;
export type FooterComponent = (props: FooterProps<any>) => Renderable;
export type ProductCardComponent = (props: ProductCardProps<any>) => Renderable;
export type ProductMainComponent = (props: ProductMainProps<any>) => Renderable;
export type ListingMainComponent = (props: ListingMainProps<any>) => Renderable;
export type SectionSkinComponent = (props: SectionSkinProps<any, any>) => Renderable;
/** Any skin component (the manifest pairs each with its target at pack time). */
export type SkinComponent = (props: any) => Renderable;
export type BlockComponent = (props: BlockProps<any>) => Renderable;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface StorefrontDefinition {
  /** Component sections by manifest section type. */
  sections?: Record<string, SectionComponent>;
  /** Skins by manifest skin id. */
  skins?: Record<string, SkinComponent>;
  /** Component product blocks by manifest block type. */
  blocks?: Record<string, BlockComponent>;
}

/** What `defineStorefront` returns: the module the storefront loads, plus the definition (for the packer and tests). */
export interface StorefrontModuleDefinition extends StorefrontModule {
  definition: StorefrontDefinition;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.slice(0, 500);
}

function renderJob(definition: StorefrontDefinition, job: StorefrontRenderJob, context: StorefrontRenderContext): string {
  switch (job.kind) {
    case "section": {
      const component = definition.sections?.[job.type];
      if (!component) throw new Error(`No component for section ${job.type}.`);
      return toHtml(component({ settings: job.settings, instanceId: job.instanceId, objects: job.objects ?? {}, context })).value;
    }
    case "block": {
      const component = definition.blocks?.[job.type];
      if (!component) throw new Error(`No component for block ${job.type}.`);
      return toHtml(component({ settings: job.settings, data: job.data, target: job.target, instanceId: job.instanceId, context })).value;
    }
    case "skin": {
      const component = definition.skins?.[job.component] as ((props: SkinProps<unknown> & { instanceId?: string }) => Renderable) | undefined;
      if (!component) throw new Error(`No component for skin ${job.component}.`);
      const instanceId = "instanceId" in job ? job.instanceId : undefined;
      return toHtml(component({ settings: job.settings, data: job.data, context, ...(instanceId !== undefined ? { instanceId } : {}) })).value;
    }
  }
}

export function defineStorefront(definition: StorefrontDefinition): StorefrontModuleDefinition {
  return {
    abi: STOREFRONT_COMPONENT_ABI,
    definition,
    render(batch: StorefrontRenderBatch): StorefrontRenderReply {
      if (batch.abi !== STOREFRONT_COMPONENT_ABI) {
        return { abi: STOREFRONT_COMPONENT_ABI, results: batch.jobs.map((job) => ({ id: job.id, error: `Unsupported render ABI ${String(batch.abi)}.` })) };
      }
      const results = batch.jobs.map((job) => {
        try {
          return { id: job.id, html: renderJob(definition, job, batch.context) };
        } catch (error) {
          return { id: job.id, error: errorText(error) };
        }
      });
      return { abi: STOREFRONT_COMPONENT_ABI, results };
    },
  };
}

/** The definition behind a storefront module's default export (the packer's handler check). */
export function storefrontDefinitionOf(value: unknown): StorefrontDefinition | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<StorefrontModuleDefinition>;
  return candidate.abi === STOREFRONT_COMPONENT_ABI && typeof candidate.render === "function" && typeof candidate.definition === "object"
    ? candidate.definition ?? null
    : null;
}
