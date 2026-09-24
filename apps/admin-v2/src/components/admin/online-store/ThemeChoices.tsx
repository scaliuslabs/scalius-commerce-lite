import { useId, useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group";
import { ArrowDown, ArrowUp } from "lucide-react";
import type {
  StorefrontCardBadgePlacement,
  StorefrontCardImageRatio,
  StorefrontFooterStyle,
  StorefrontHeaderStyle,
  StorefrontHomepageSection,
  StorefrontProductGalleryLayout,
  StorefrontProductThumbnailPlacement,
  StorefrontThemeCornerStyle,
} from "@scalius/shared/storefront-theme";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { moveHomepageSection } from "./theme-settings";

/**
 * Visual radio options: a schematic of each choice with its name under it.
 * Arrow keys move between options (Radix radio group, roving focus).
 */
export function VisualChoice<Value extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string; sketch: ReactNode }>;
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <p id={labelId} className="text-body font-medium">{label}</p>
      <RadioGroupPrimitive.Root
        aria-labelledby={labelId}
        value={value}
        onValueChange={(next) => onChange(next as Value)}
        className={cn("grid gap-3", options.length > 2 ? "grid-cols-3" : "grid-cols-2")}
      >
        {options.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={option.value}
            className="rounded-xl border bg-card p-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card data-[state=checked]:border-primary data-[state=checked]:outline-1 data-[state=checked]:outline-primary"
          >
            {option.sketch}
            <span className="block px-1 pt-1.5 pb-0.5 text-body">{option.label}</span>
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

/** A short run of mutually exclusive values (products per row). */
export function SegmentedChoice<Value extends number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: Value;
  options: ReadonlyArray<{ value: Value; label: string }>;
  onChange: (value: Value) => void;
}) {
  const labelId = useId();
  return (
    <div className="space-y-1.5">
      <p id={labelId} className="text-body font-medium">{label}</p>
      <RadioGroupPrimitive.Root
        aria-labelledby={labelId}
        value={String(value)}
        onValueChange={(next) => onChange(Number(next) as Value)}
        orientation="horizontal"
        className="inline-flex gap-0.5 rounded-lg bg-secondary p-0.5"
      >
        {options.map((option) => (
          <RadioGroupPrimitive.Item
            key={option.value}
            value={String(option.value)}
            className="h-11 min-w-12 rounded-md px-3 text-body tabular-nums hover:bg-secondary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-card data-[state=checked]:shadow-button sm:h-8"
          >
            {option.label}
          </RadioGroupPrimitive.Item>
        ))}
      </RadioGroupPrimitive.Root>
    </div>
  );
}

/** Homepage sections in order, each with Move up / Move down (no drag). */
export function HomepageOrder({
  order,
  onChange,
}: {
  order: readonly StorefrontHomepageSection[];
  onChange: (order: StorefrontHomepageSection[]) => void;
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
  const move = (section: StorefrontHomepageSection, delta: -1 | 1) => {
    const next = moveHomepageSection(order, section, delta);
    const index = next.indexOf(section);
    const atEnd = delta < 0 ? index === 0 : index === next.length - 1;
    focusNext.current = `${section}:${atEnd ? -delta : delta}`;
    onChange(next);
  };
  const buttonRef = (key: string) => (node: HTMLButtonElement | null) => {
    if (node) buttons.current.set(key, node);
    else buttons.current.delete(key);
  };

  return (
    <ol>
      {order.map((section, index) => {
        const name = t(`section_${section}` as const);
        return (
          <li key={section} className="flex min-h-12 items-center gap-1 border-t border-border py-1 pr-2 pl-4 first:border-t-0">
            <span className="min-w-0 flex-1 text-body">{name}</span>
            <Button
              ref={buttonRef(`${section}:-1`)}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveSectionUp", { name })}
              disabled={index === 0}
              onClick={() => move(section, -1)}
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              ref={buttonRef(`${section}:1`)}
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("moveSectionDown", { name })}
              disabled={index === order.length - 1}
              onClick={() => move(section, 1)}
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
 * its preview. Everything is a <span>: sketches sit inside radio buttons.
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

export function HeaderRows({ kind }: { kind: StorefrontHeaderStyle }) {
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

export function HeaderSketch({ kind }: { kind: StorefrontHeaderStyle }) {
  return (
    <Sketch>
      <HeaderRows kind={kind} />
      <Filler className="mt-1" />
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

export function FooterSketch({ kind }: { kind: StorefrontFooterStyle }) {
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

const CORNERS: Record<StorefrontThemeCornerStyle, string> = {
  square: "rounded-none",
  subtle: "rounded-xs",
  rounded: "rounded-sm",
};

/** One product card: photo, name, price, optional discount badge. */
export function ProductTile({
  ratio,
  badge,
  corners = "subtle",
  className,
}: {
  ratio: StorefrontCardImageRatio;
  badge?: StorefrontCardBadgePlacement;
  corners?: StorefrontThemeCornerStyle;
  /** Width cap, so a tall photo still fits the sketch. */
  className: string;
}) {
  return (
    <span className={cn("flex w-full min-w-0 flex-col gap-1", className)}>
      <span className={cn("relative block bg-(--sk-soft)", ratio === "portrait" ? "aspect-3/4" : "aspect-square", CORNERS[corners])}>
        {badge === "image" ? <span className="absolute top-0.5 left-0.5 h-1 w-2 rounded-xs bg-(--sk-accent)" /> : null}
      </span>
      <Line className="w-full" />
      <span className="flex items-center gap-0.5">
        <span className="h-1 w-2.5 rounded-xs bg-(--sk-ink)" />
        {badge === "price" ? <span className="h-1 w-2 rounded-xs bg-(--sk-accent)" /> : null}
      </span>
    </span>
  );
}

export function CardSketch({ ratio, badge }: { ratio: StorefrontCardImageRatio; badge?: StorefrontCardBadgePlacement }) {
  return (
    <Sketch className="flex-row items-start justify-center gap-2">
      <ProductTile ratio={ratio} badge={badge} className="max-w-9" />
      <ProductTile ratio={ratio} badge={badge} className="max-w-9" />
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

export function GallerySketch({ layout }: { layout: StorefrontProductGalleryLayout }) {
  return layout === "stacked" ? (
    <Sketch>
      <Block className="h-7 shrink-0" />
      <Details />
    </Sketch>
  ) : (
    <Sketch className="flex-row gap-1.5">
      <Block className="w-1/2" />
      <Details />
    </Sketch>
  );
}

export function ThumbnailSketch({ placement }: { placement: StorefrontProductThumbnailPlacement }) {
  const thumbs = (
    <>
      <Block className="size-2.5 shrink-0" />
      <Block className="size-2.5 shrink-0" />
      <Block className="size-2.5 shrink-0" />
    </>
  );
  return (
    <Sketch className={cn("items-center", placement === "beside" && "flex-row justify-center")}>
      {placement === "beside" ? <span className="flex flex-col gap-1">{thumbs}</span> : null}
      <Block className="size-12 shrink-0" />
      {placement === "below" ? <span className="flex gap-1">{thumbs}</span> : null}
    </Sketch>
  );
}
