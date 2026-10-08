import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@scalius/shared/utils";
import { formatNumber } from "~/i18n";

export interface IndexTab<T extends string> {
  value: T;
  label: string;
  /** A count after the label (Polaris Tabs' `badge`). */
  badge?: number;
}

interface IndexTabsProps<T extends string> {
  tabs: ReadonlyArray<IndexTab<T>>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
}

/**
 * Shopify-style view tabs across the top of a list card (All, Draft, Trash…).
 * When they don't fit (a phone), the edge that has more tabs fades out, and the
 * chosen tab is scrolled into view, so a cut-off tab reads as "scroll", not as broken.
 */
export function IndexTabs<T extends string>({ tabs, value, onChange, label }: IndexTabsProps<T>) {
  const list = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ before: false, after: false });

  const measure = useCallback(() => {
    const element = list.current;
    if (!element) return;
    // scrollLeft is negative in right-to-left writing: its size is the distance travelled.
    const travelled = Math.abs(element.scrollLeft);
    const before = travelled > 1;
    const after = travelled + element.clientWidth < element.scrollWidth - 1;
    setMore((current) => (current.before === before && current.after === after ? current : { before, after }));
  }, []);

  useLayoutEffect(() => {
    measure();
    const element = list.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, tabs]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);

  return (
    <div className="relative border-b">
      <div ref={list} role="tablist" aria-label={label} onScroll={measure} className="scrollbar-hide flex gap-1 overflow-x-auto px-2 py-1.5">
        {tabs.map((tab) => {
          const active = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onChange(tab.value)}
              className={cn(
                "min-h-11 shrink-0 rounded-md px-3 text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
                active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              )}
            >
              {tab.label}
              {tab.badge !== undefined ? <span className="ms-1.5 tabular-nums text-muted-foreground">{formatNumber(tab.badge)}</span> : null}
            </button>
          );
        })}
      </div>
      {/* Fades sit over the edges and take no clicks; they only exist while there is more that way. */}
      <span
        aria-hidden="true"
        data-fade="before"
        className={cn("pointer-events-none absolute inset-y-0 inset-s-0 w-8 bg-linear-to-r from-card to-transparent rtl:bg-linear-to-l", !more.before && "hidden")}
      />
      <span
        aria-hidden="true"
        data-fade="after"
        className={cn("pointer-events-none absolute inset-y-0 inset-e-0 w-8 bg-linear-to-l from-card to-transparent rtl:bg-linear-to-r", !more.after && "hidden")}
      />
    </div>
  );
}
