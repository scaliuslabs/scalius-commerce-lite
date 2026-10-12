// `defineStorefront`: an app's storefront module. It maps the manifest's
// component sections and slots to components and answers the storefront's
// render batches (the protocol in @scalius/shared/plugins/storefront-protocol).
// Each job renders alone: a component that throws fails only its own job,
// and the storefront then draws nothing there (a section) or its own block
// (a slot).

import {
  STOREFRONT_COMPONENT_ABI,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontModule,
  type StorefrontProductCard,
  type StorefrontRenderBatch,
  type StorefrontRenderContext,
  type StorefrontRenderJob,
  type StorefrontRenderReply,
  type StorefrontResolvedSettings,
} from "@scalius/shared/plugins/storefront-protocol";
import { toHtml, type Renderable } from "./html";

export interface SectionProps<Settings = StorefrontResolvedSettings> {
  settings: Settings;
  /** The theme's id of this placement (stable while the merchant keeps it). */
  instanceId: string;
  context: StorefrontRenderContext;
}

export interface SlotProps<Data, Settings = StorefrontResolvedSettings> {
  settings: Settings;
  data: Data;
  context: StorefrontRenderContext;
}

export type HeaderProps<Settings = StorefrontResolvedSettings> = SlotProps<StorefrontHeaderData, Settings>;
export type FooterProps<Settings = StorefrontResolvedSettings> = SlotProps<StorefrontFooterData, Settings>;
export type ProductCardProps<Settings = StorefrontResolvedSettings> = SlotProps<
  { product: StorefrontProductCard; position: number; aboveFold: boolean },
  Settings
>;

// Components take their own settings shapes; the module map is checked by
// the manifest at pack time, so the map itself is loosely typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type SectionComponent = (props: SectionProps<any>) => Renderable;
export type HeaderComponent = (props: HeaderProps<any>) => Renderable;
export type FooterComponent = (props: FooterProps<any>) => Renderable;
export type ProductCardComponent = (props: ProductCardProps<any>) => Renderable;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface StorefrontDefinition {
  /** Component sections by manifest section type. */
  sections?: Record<string, SectionComponent>;
  /** Slot components by manifest slot id. */
  slots?: Record<string, HeaderComponent | FooterComponent | ProductCardComponent>;
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
  if (job.kind === "section") {
    const component = definition.sections?.[job.type];
    if (!component) throw new Error(`No component for section ${job.type}.`);
    return toHtml(component({ settings: job.settings, instanceId: job.instanceId, context })).value;
  }
  const component = definition.slots?.[job.component] as ((props: SlotProps<unknown>) => Renderable) | undefined;
  if (!component) throw new Error(`No component for slot ${job.component}.`);
  return toHtml(component({ settings: job.settings, data: job.data, context })).value;
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
