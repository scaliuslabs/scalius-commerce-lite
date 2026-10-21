// `defineStorefront`: an app's storefront module. It maps the manifest's
// sections, components and skins to render functions and
// answers the storefront's render batches (the protocol in
// @scalius/shared/plugins/storefront-protocol). Each job renders alone: a
// component that throws fails only its own job, and the storefront then draws
// nothing there (a section or component) or the core unit (a skin).

import {
  STOREFRONT_COMPONENT_ABI,
  type StorefrontComponentSlot,
  type StorefrontFooterData,
  type StorefrontHeaderData,
  type StorefrontListingPage,
  type StorefrontModule,
  type StorefrontProductCardData,
  type StorefrontProductCardSlot,
  type StorefrontProductPage,
  type StorefrontProductSlot,
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
/** A product_main skin: place the store's buy form with `<BuyForm />` (exactly one; without it core draws the page). */
export type ProductMainProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontProductPage, Settings>;
/** A listing_main skin: `<Filters />`, `<Toolbar />` and `<Pagination />` place the store's own (pagination is appended when left out). */
export type ListingMainProps<Settings = StorefrontResolvedSettings> = SkinProps<StorefrontListingPage, Settings>;
/** A core section's skin (`section:<type>`): the section's sealed projection (`StorefrontSectionSkinSettings[type]`). */
export type SectionSkinProps<Type extends StorefrontSkinnableSection = StorefrontSkinnableSection, Settings = StorefrontResolvedSettings> =
  SkinProps<StorefrontSectionSkinData<StorefrontSectionSkinSettings[Type]>, Settings> & {
    /** The theme's id of the section placement. */
    instanceId: string;
  };

/** A component in a product-page slot (`product.buy_box.before`, `product.buy_box.after`, `product.below`). */
export interface ProductSlotComponentProps<Settings = StorefrontResolvedSettings, Target extends StorefrontProductSlot = StorefrontProductSlot> {
  target: Target;
  settings: Settings;
  /** The product page, as a product_main skin gets it. */
  data: StorefrontProductPage;
  /** The theme's id of this placement. */
  instanceId: string;
  context: StorefrontRenderContext;
}

/** A component in a product-card slot (`product_card.badges`, `product_card.meta`). */
export interface ProductCardSlotComponentProps<Settings = StorefrontResolvedSettings, Target extends StorefrontProductCardSlot = StorefrontProductCardSlot> {
  target: Target;
  settings: Settings;
  /** The card it draws on, as a product_card skin gets it (another app's skin may own the card). */
  data: StorefrontProductCardData;
  context: StorefrontRenderContext;
}

/** The slots of the store's layout: `header.actions`, `footer.columns`. */
export type StorefrontLayoutSlot = Exclude<StorefrontComponentSlot, StorefrontProductSlot | StorefrontProductCardSlot>;

/** A component in a layout slot: settings only. */
export interface LayoutSlotComponentProps<Settings = StorefrontResolvedSettings, Target extends StorefrontLayoutSlot = StorefrontLayoutSlot> {
  target: Target;
  settings: Settings;
  context: StorefrontRenderContext;
}

/** A component drawn as an app page (`target: "page"`) with its proxy route's props. */
export interface PageComponentProps<Settings = StorefrontResolvedSettings, Props = Record<string, unknown>> {
  target: "page";
  settings: Settings;
  /** What the app's proxy route answered (`{ page: { component, props } }`). */
  props: Props;
  context: StorefrontRenderContext;
}

/** Every target a component may declare (`storefront.components[].targets`). */
export type StorefrontComponentTargetName = StorefrontComponentSlot | "page";

/**
 * What a component gets at one target, by target:
 * `ComponentPropsFor<"product.below">` is `ProductSlotComponentProps`,
 * `ComponentPropsFor<"product_card.badges" | "header.actions">` the union of
 * the two. Use it with `componentFor` for a component that declares only
 * some targets.
 */
export type ComponentPropsFor<Target extends StorefrontComponentTargetName, Settings = StorefrontResolvedSettings, Props = Record<string, unknown>> =
  Target extends StorefrontProductSlot ? ProductSlotComponentProps<Settings, Target>
    : Target extends StorefrontProductCardSlot ? ProductCardSlotComponentProps<Settings, Target>
      : Target extends "page" ? PageComponentProps<Settings, Props>
        : Target extends StorefrontLayoutSlot ? LayoutSlotComponentProps<Settings, Target>
          : never;

/**
 * What a component gets at any of its targets (`target` says which): its
 * settings; in a product slot also the product page (`data`) and the
 * placement's id; in a card slot the card (`data`); on `page` the app's
 * proxy route's `props`. Narrow it by `target` before reading those:
 *
 *   (props: ComponentProps) => {
 *     switch (props.target) {
 *       case "product.below": return <p>{props.data.product.title}</p>;
 *       case "page": return <h2>{String(props.props.name)}</h2>;
 *       default: return null;
 *     }
 *   }
 *
 * or declare the targets once with `componentFor`.
 */
export type ComponentProps<Settings = StorefrontResolvedSettings, Props = Record<string, unknown>> =
  ComponentPropsFor<StorefrontComponentTargetName, Settings, Props>;

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
export type AppComponent = (props: ComponentProps<any, any>) => Renderable;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A component for some targets only, with its props typed by them:
 *
 *   components: {
 *     size_guide: componentFor(["product.buy_box.after", "product.below"], ({ data }) =>
 *       <aside>{data.product.title}</aside>),
 *   }
 *
 * List the same targets as the manifest's `targets`. At any other target it
 * throws, so a manifest that adds a target the component does not handle
 * fails `pnpm plugin validate` (its smoke render draws every declared
 * target) instead of drawing nothing in the store.
 */
export function componentFor<const Targets extends readonly StorefrontComponentTargetName[], Settings = StorefrontResolvedSettings, Props = Record<string, unknown>>(
  targets: Targets,
  render: (props: ComponentPropsFor<Targets[number], Settings, Props>) => Renderable,
): AppComponent {
  const allowed = new Set<string>(targets);
  return (props) => {
    if (!allowed.has(props.target)) throw new Error(`This component draws at ${targets.join(", ")}, not ${props.target}.`);
    return render(props as ComponentPropsFor<Targets[number], Settings, Props>);
  };
}

export interface StorefrontDefinition {
  /** Component sections by manifest section type. */
  sections?: Record<string, SectionComponent>;
  /** Skins by manifest skin id. */
  skins?: Record<string, SkinComponent>;
  /** Components by manifest component type (`storefront.components`). */
  components?: Record<string, AppComponent>;
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
    case "component": {
      const component = definition.components?.[job.type];
      if (!component) throw new Error(`No component for ${job.type}.`);
      const { id: _id, kind: _kind, type: _type, ...props } = job;
      return toHtml(component({ ...props, context } as ComponentProps)).value;
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
