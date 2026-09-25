import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import type {
  ResolvedStorefrontThemeLayout,
  StorefrontDensity,
  StorefrontFooterRenderer,
  StorefrontGalleryRenderer,
  StorefrontHeaderRenderer,
  StorefrontMobileNavigationRenderer,
  StorefrontNavigationRenderer,
  StorefrontHeadingCase,
  StorefrontSectionType,
  StorefrontThemeTokens,
  StorefrontTypeScale,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { moveSection } from "./theme-settings";

/**
 * Visual radio options: a schematic of each choice with its name under it.
 * Arrow keys move between options (Radix radio group, roving focus).
 */
export function VisualChoice<Value extends string>({
  label,
  showLabel = false,
  value,
  options,
  onChange,
  className = "grid-cols-3",
}: {
  label: string;
  /** Show the label above the options (when a card holds more than one choice). */
  showLabel?: boolean;
  /** Null when no option matches (a fine-tuned Style). */
  value: Value | null;
  /** `badge` sits beside the name (a template's default, say). */
  options: ReadonlyArray<{ value: Value; label: string; help?: string; badge?: ReactNode; sketch: ReactNode }>;
  onChange: (value: Value) => void;
  /** Grid columns. */
  className?: string;
}) {
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <p id={labelId} className={showLabel ? "text-body font-medium" : "sr-only"}>{label}</p>
      <RadioGroupPrimitive.Root
        aria-labelledby={labelId}
        value={value ?? ""}
        onValueChange={(next) => onChange(next as Value)}
        className={cn("grid gap-3", className)}
      >
        {options.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            className="group flex flex-col rounded-xl border bg-card p-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card data-[state=checked]:border-primary data-[state=checked]:outline-1 data-[state=checked]:outline-primary"
          >
            {option.sketch}
            <span className="flex items-start justify-between gap-1 px-1 pt-1.5 text-body font-medium">
              {option.badge ? (
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {option.label}
                  {option.badge}
                </span>
              ) : option.label}
              <span className="hidden h-lh items-center group-data-[state=checked]:flex">
                <Check className="size-4 shrink-0" aria-hidden="true" />
              </span>
            </span>
            {option.help ? (
              <span className="block px-1 pb-0.5 text-body text-muted-foreground">{option.help}</span>
            ) : null}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

/**
 * Homepage sections in order, each with Move up / Move down (no drag). A
 * section the store does not show says why under its name.
 */
export function HomepageOrder<Section extends { id: string; type: StorefrontSectionType }>({
  sections,
  notes = {},
  onChange,
}: {
  sections: readonly Section[];
  /** Why a section does not show on the store, by section id. */
  notes?: Readonly<Record<string, string>>;
  onChange: (sections: Section[]) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const focusNext = useRef<string | null>(null);
  // The moved row keeps keyboard focus, on the button that can still move it.
  useLayoutEffect(() => {
    if (!focusNext.current) return;
    buttons.current.get(focusNext.current)?.focus();
    focusNext.current = null;
  });
  const move = (id: string, delta: -1 | 1) => {
    const next = moveSection(sections, id, delta);
    const index = next.findIndex((section) => section.id === id);
    const atEnd = delta < 0 ? index === 0 : index === next.length - 1;
    focusNext.current = `${id}:${atEnd ? -delta : delta}`;
    onChange(next);
  };
  const buttonRef = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(key, node);
    else buttons.current.delete(key);
  };

  return (
    <ol>
      {sections.map((section, index) => {
        const name = t(`section_${section.type}`);
        const note = notes[section.id];
        return (
          <li key={section.id} className="flex min-h-12 items-center gap-1 border-t border-border py-1 pr-2 pl-4 first:border-t-0">
            <span className="min-w-0 flex-1 text-body">
              {name}
              {note ? <span className="block text-muted-foreground">{note}</span> : null}
            </span>
            <Button
              ref={buttonRef(`${section.id}:-1`)}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveSectionUp", { name })}
              disabled={index === 0}
              onClick={() => move(section.id, -1)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              ref={buttonRef(`${section.id}:1`)}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveSectionDown", { name })}
              disabled={index === sections.length - 1}
              onClick={() => move(section.id, 1)}
            >
              <ArrowDown aria-hidden="true" />
            </Button>
          </li>
        );
      })}
    </ol>
  );
}

/*
 * Schematics. Parts paint with the --sk-* custom properties, so the same
 * drawing shows dashboard tokens in the pickers and a Style's own colours in
 * its preview. Everything is a decorative <span>: sketches sit inside radio
 * buttons, whose label names the choice.
 */

export interface SketchPalette {
  paper: string;
  ink: string;
  line: string;
  soft: string;
  edge: string;
  accent: string;
}

const TOKEN_PALETTE: SketchPalette = {
  paper: "var(--card)",
  ink: "var(--muted-foreground)",
  line: "var(--input)",
  soft: "var(--secondary)",
  edge: "var(--border)",
  accent: "var(--primary)",
};

export function Sketch({
  palette = TOKEN_PALETTE,
  className,
  children,
}: {
  palette?: SketchPalette;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden="true"
      // Colours reach CSS only as custom properties (DESIGN.md).
      style={{
        "--sk-paper": palette.paper,
        "--sk-ink": palette.ink,
        "--sk-line": palette.line,
        "--sk-soft": palette.soft,
        "--sk-edge": palette.edge,
        "--sk-accent": palette.accent,
      } as CSSProperties}
      className={cn(
        "flex h-20 flex-col gap-1 overflow-clip rounded-lg border border-(--sk-edge) bg-(--sk-paper) p-1.5",
        className,
      )}
    >
      {children}
    </span>
  );
}

const Logo = ({ className }: { className?: string }) => <span className={cn("h-1.5 w-4 shrink-0 rounded-xs bg-(--sk-ink)", className)} />;
const Line = ({ className }: { className?: string }) => <span className={cn("h-0.5 w-3 shrink-0 rounded-full bg-(--sk-line)", className)} />;
const Dot = () => <span className="size-1.5 shrink-0 rounded-full bg-(--sk-line)" />;
const Block = ({ className }: { className?: string }) => <span className={cn("block rounded-xs bg-(--sk-soft)", className)} />;

/** Page content under a header or above a footer. */
const Filler = ({ className }: { className?: string }) => (
  <span className={cn("flex flex-1 gap-1", className)}>
    <Block className="flex-1" />
    <Block className="flex-1" />
    <Block className="flex-1" />
  </span>
);

export function HeaderRows({ kind }: { kind: StorefrontHeaderRenderer }) {
  if (kind === "centered") {
    return (
      <>
        <span className="flex items-center gap-1">
          <span className="size-1.5 shrink-0 rounded-full border border-(--sk-line)" />
          <Logo className="mx-auto w-5" />
          <Dot />
          <Dot />
        </span>
        <span className="flex justify-center gap-1">
          <Line />
          <Line />
          <Line />
        </span>
      </>
    );
  }
  if (kind === "marketplace") {
    return (
      <>
        <span className="flex items-center gap-1">
          <Logo />
          <span className="flex h-2.5 flex-1 justify-end rounded-xs border border-(--sk-accent) bg-(--sk-paper)">
            <span className="w-2 bg-(--sk-accent)" />
          </span>
          <Dot />
          <Dot />
        </span>
        <span className="flex gap-1">
          <Block className="h-1 w-3" />
          <Block className="h-1 w-3" />
          <Block className="h-1 w-3" />
        </span>
      </>
    );
  }
  return (
    <>
      <span className="flex items-center gap-1">
        <Logo />
        <span className="mx-auto h-1.5 w-2/5 rounded-full border border-(--sk-line)" />
        <Dot />
        <Dot />
      </span>
      <span className="flex gap-1">
        <Line />
        <Line />
        <Line />
      </span>
    </>
  );
}

export function HeaderSketch({ kind }: { kind: StorefrontHeaderRenderer }) {
  return (
    <Sketch>
      <HeaderRows kind={kind} />
      <Filler className="mt-1" />
    </Sketch>
  );
}

/** The page under the header: a menu open over it, a category row, or a side column. */
export function NavigationSketch({ kind }: { kind: StorefrontNavigationRenderer }) {
  const header = (
    <span className="flex items-center gap-1">
      <Logo />
      <span className="flex gap-1">
        <Line className="bg-(--sk-accent)" />
        <Line />
        <Line />
      </span>
      <span className="ml-auto flex gap-1">
        <Dot />
        <Dot />
      </span>
    </span>
  );
  if (kind === "pills") {
    return (
      <Sketch>
        {header}
        <span className="flex gap-1 overflow-clip">
          {[0, 1, 2, 3, 4].map((index) => (
            <span key={index} className="h-2 w-4 shrink-0 rounded-full border border-(--sk-line)" />
          ))}
        </span>
        <Filler />
      </Sketch>
    );
  }
  if (kind === "sidebar") {
    return (
      <Sketch>
        {header}
        <span className="flex flex-1 gap-1.5">
          <span className="flex w-1/4 shrink-0 flex-col gap-1 border-r border-(--sk-edge) pt-0.5 pr-1">
            <Line className="w-full bg-(--sk-accent)" />
            <Line className="w-full" />
            <Line className="w-2/3" />
            <Line className="w-full" />
          </span>
          <Filler />
        </span>
      </Sketch>
    );
  }
  return (
    <Sketch className="relative">
      {header}
      <Filler className="mt-1" />
      {kind === "mega" ? (
        // A full-width panel of columns, each led by a category photo.
        <span className="absolute inset-x-1.5 top-4 flex gap-1.5 rounded-xs border border-(--sk-edge) bg-(--sk-paper) p-1">
          {[0, 1, 2].map((index) => (
            <span key={index} className="flex flex-1 flex-col gap-1">
              <Block className="h-3" />
              <Line className="w-full" />
              <Line className="w-2/3" />
            </span>
          ))}
        </span>
      ) : (
        // A short list under the open item.
        <span className="absolute top-4 left-7 flex w-8 flex-col gap-1 rounded-xs border border-(--sk-edge) bg-(--sk-paper) p-1">
          <Line className="w-full" />
          <Line className="w-2/3" />
          <Line className="w-full" />
        </span>
      )}
    </Sketch>
  );
}

/** A phone: the menu drawer open from the side, or a tab bar along the bottom. */
export function MobileNavigationSketch({ kind }: { kind: StorefrontMobileNavigationRenderer }) {
  return (
    <Sketch className="items-center">
      <span className="relative flex h-full w-12 flex-col gap-1 overflow-clip rounded-sm border border-(--sk-edge) p-1">
        <span className="flex items-center gap-1">
          <span className="flex flex-col gap-px">
            <span className="h-px w-1.5 bg-(--sk-ink)" />
            <span className="h-px w-1.5 bg-(--sk-ink)" />
            <span className="h-px w-1.5 bg-(--sk-ink)" />
          </span>
          <Logo className="mx-auto w-3" />
          <Dot />
        </span>
        <span className="grid flex-1 grid-cols-2 content-start gap-0.5">
          <Block className="aspect-square" />
          <Block className="aspect-square" />
        </span>
        {kind === "tabs" ? (
          <span className="flex justify-between border-t border-(--sk-edge) pt-0.5">
            <span className="size-1.5 shrink-0 rounded-full bg-(--sk-accent)" />
            <Dot />
            <Dot />
            <Dot />
            <Dot />
          </span>
        ) : (
          <span className="absolute inset-y-0 left-0 flex w-2/3 flex-col gap-1 border-r border-(--sk-edge) bg-(--sk-paper) p-1">
            <Line className="w-full bg-(--sk-accent)" />
            <Line className="w-full" />
            <Line className="w-2/3" />
            <Line className="w-full" />
          </span>
        )}
      </span>
    </Sketch>
  );
}

const LineStack = () => (
  <span className="flex flex-col gap-1">
    <Line />
    <Line className="w-2" />
    <Line />
  </span>
);

export function FooterSketch({ kind }: { kind: StorefrontFooterRenderer }) {
  return (
    <Sketch>
      <Filler className="mb-1" />
      <span className="border-t border-(--sk-edge) pt-1.5">
        {kind === "compact" ? (
          <span className="flex items-center gap-1">
            <Logo className="w-3" />
            <span className="mx-auto flex gap-1">
              <Line className="w-2" />
              <Line className="w-2" />
              <Line className="w-2" />
            </span>
            <Dot />
            <Dot />
          </span>
        ) : kind === "contact" ? (
          <span className="flex gap-2">
            <LineStack />
            <LineStack />
            <span className="ml-auto flex flex-col gap-1">
              <span className="h-1.5 w-5 rounded-full bg-(--sk-accent)" />
              <span className="h-1.5 w-5 rounded-full border border-(--sk-accent)" />
            </span>
          </span>
        ) : (
          <span className="flex gap-2">
            <span className="flex flex-col gap-1">
              <Logo className="w-3" />
              <Line />
            </span>
            <LineStack />
            <LineStack />
            <LineStack />
          </span>
        )}
      </span>
    </Sketch>
  );
}

const CORNERS: Record<StorefrontThemeTokens["radius"], string> = {
  square: "rounded-none",
  subtle: "rounded-xs",
  rounded: "rounded-sm",
  soft: "rounded-md",
};

/** What a card renders: its photo shape, badge, buy button and second photo. */
export type CardFacts = ResolvedStorefrontThemeLayout["productCard"];

/** One product card as its variant draws it: photo shape, badge, buy-now button, second photo. */
/** The photo box per image ratio token, as the storefront card draws it. */
export const SKETCH_RATIOS = {
  square: "aspect-square",
  portrait: "aspect-3/4",
  landscape: "aspect-4/3",
} as const satisfies Record<CardFacts["imageRatio"], string>;

export function ProductTile({
  card,
  radius = "subtle",
  badge = false,
  className,
}: {
  card: CardFacts;
  radius?: StorefrontThemeTokens["radius"];
  /** Draw the discount badge on this tile. */
  badge?: boolean;
  /** Width cap, so a tall photo still fits the sketch. */
  className: string;
}) {
  const spec = card;
  return (
    <span className={cn("flex w-full min-w-0 flex-col gap-1", className)}>
      <span
        className={cn(
          "relative flex overflow-clip bg-(--sk-soft)",
          SKETCH_RATIOS[spec.imageRatio],
          CORNERS[radius],
        )}
      >
        {/* The second photo that shows on hover. */}
        {spec.hoverImage ? <span className="ml-auto w-1/3 bg-(--sk-edge)" /> : null}
        {badge && spec.badge !== "price" ? <span className="absolute top-0.5 left-0.5 h-1 w-2 rounded-xs bg-(--sk-accent)" /> : null}
      </span>
      <Line className="w-full" />
      <span className="flex items-center gap-0.5">
        <span className="h-1 w-2.5 rounded-xs bg-(--sk-ink)" />
        {badge && spec.badge !== "image" ? <span className="h-1 w-2 rounded-xs bg-(--sk-accent)" /> : null}
      </span>
      {spec.quickBuy ? <span className={cn("h-1.5 w-full bg-(--sk-accent)", CORNERS[radius])} /> : null}
    </span>
  );
}

export function CardStyleSketch({ card }: { card: CardFacts }) {
  return (
    <Sketch className="flex-row items-start justify-center gap-2">
      <ProductTile card={card} badge className="max-w-9" />
      <ProductTile card={card} className="max-w-9" />
    </Sketch>
  );
}

/**
 * A computer screen and a phone filled with products: dense and compact fit
 * more, smaller cards with tighter gaps; comfortable and airy show fewer,
 * larger ones. All keep two products across on phones.
 */
export function DensitySketch({ density }: { density: StorefrontDensity }) {
  const compact = density === "compact" || density === "dense";
  const tiles = (count: number) => Array.from({ length: count }, (_, index) => (
    <Block key={index} className="aspect-square" />
  ));
  return (
    <Sketch className="flex-row items-start gap-2">
      <span className={cn("grid flex-1 content-start", compact ? "grid-cols-5 gap-0.5" : "grid-cols-3 gap-1.5")}>
        {tiles(compact ? 10 : 6)}
      </span>
      <span
        className={cn(
          "grid w-6 shrink-0 grid-cols-2 content-start rounded-xs border border-(--sk-edge) p-0.5",
          compact ? "gap-0.5" : "gap-1",
        )}
      >
        {tiles(compact ? 6 : 4)}
      </span>
    </Sketch>
  );
}

const Details = () => (
  <span className="flex flex-1 flex-col gap-1">
    <Logo className="w-full" />
    <Line className="w-2/3" />
    <Line className="w-1/2" />
    <span className="mt-0.5 h-2 w-full rounded-xs bg-(--sk-accent)" />
  </span>
);

const Thumbs = ({ className }: { className?: string }) => (
  <span className={cn("flex shrink-0 gap-0.5", className)}>
    <Block className="size-2" />
    <Block className="size-2" />
    <Block className="size-2" />
  </span>
);

export function ProductPageSketch({ layout }: { layout: StorefrontGalleryRenderer }) {
  const spec = layout;
  const photo = (
    <span className={cn("flex min-w-0 gap-0.5", spec.thumbnails === "beside" ? "flex-row" : "flex-col")}>
      {spec.thumbnails === "beside" ? <Thumbs className="flex-col" /> : null}
      <Block className={cn("min-w-0 flex-1", spec.gallery === "stacked" ? "h-6" : "aspect-square")} />
      {spec.thumbnails === "below" ? <Thumbs /> : null}
    </span>
  );
  return spec.gallery === "stacked" ? (
    <Sketch>
      {photo}
      <Details />
    </Sketch>
  ) : (
    <Sketch className="flex-row gap-1.5">
      <span className="w-1/2 shrink-0">{photo}</span>
      <Details />
    </Sketch>
  );
}

/**
 * Section titles against body text: small (flat), today's size (retail) and
 * large display titles, as a bar over two lines of text.
 */
const TYPE_SCALE_TITLE: Record<StorefrontTypeScale, string> = {
  flat: "h-1.5 w-8",
  retail: "h-2.5 w-12",
  display: "h-4 w-16",
};

export function TypeScaleSketch({ scale }: { scale: StorefrontTypeScale }) {
  return (
    <Sketch className="justify-center gap-1.5">
      <span className={cn("shrink-0 rounded-xs bg-(--sk-ink)", TYPE_SCALE_TITLE[scale])} />
      <Line className="w-full" />
      <Line className="w-2/3" />
    </Sketch>
  );
}

/** A section title as buyers read it: sentence case or all capitals (product names never change). */
export function HeadingCaseSketch({ headingCase, sample }: { headingCase: StorefrontHeadingCase; sample: string }) {
  return (
    <Sketch className="justify-center gap-1.5">
      <span className="truncate text-body font-medium text-(--sk-ink)">
        {headingCase === "uppercase" ? sample.toLocaleUpperCase("en") : sample}
      </span>
      <Line className="w-full" />
      <Line className="w-2/3" />
    </Sketch>
  );
}
