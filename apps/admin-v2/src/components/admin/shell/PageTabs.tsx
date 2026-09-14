import type { ComponentType, KeyboardEvent } from "react";
import { useRef } from "react";

import { cn } from "@scalius/shared/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";

export type PageTabIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export interface PageTabItem {
  /** The value carried in the URL. */
  value: string;
  label: string;
  icon?: PageTabIcon;
  /** Result count shown after the label on wide screens. */
  count?: number;
  disabled?: boolean;
}

export interface PageTabsProps {
  tabs: readonly PageTabItem[];
  value: string;
  onChange: (value: string) => void;
  /** Names the tab strip and the mobile select. Default: "Sections". */
  label?: string;
  /**
   * `id` of the element that renders the active section. Give the panel
   * `role="tabpanel"` so the selected tab really controls something.
   */
  panelId?: string;
  className?: string;
}

/** Index of the next enabled tab, wrapping at both ends. */
function nextEnabledIndex(
  tabs: readonly PageTabItem[],
  from: number,
  step: number,
): number {
  for (let offset = 1; offset <= tabs.length; offset += 1) {
    const index = (from + step * offset + tabs.length * offset) % tabs.length;
    if (!tabs[index]?.disabled) return index;
  }
  return from;
}

/**
 * The section switcher used by workspace pages that keep their tab in the URL:
 * a tab strip from `sm` up, and a select below it because four tabs do not fit
 * on a 375px screen. Selecting a tab only reports the new value — the caller
 * owns the URL and renders the panel.
 *
 * Arrow keys, Home and End move between tabs and select as they go, which is
 * the automatic-activation pattern these URL-driven tabs want.
 */
export function PageTabs({
  tabs,
  value,
  onChange,
  label = "Sections",
  panelId,
  className,
}: PageTabsProps) {
  const tabRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.value === value));

  function focusTab(index: number) {
    const tab = tabs[index];
    if (!tab) return;
    tabRefs.current.get(tab.value)?.focus();
    if (tab.value !== value) onChange(tab.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (tabs.length === 0) return;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      focusTab(nextEnabledIndex(tabs, activeIndex, 1));
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      focusTab(nextEnabledIndex(tabs, activeIndex, -1));
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusTab(nextEnabledIndex(tabs, tabs.length - 1, 1));
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusTab(nextEnabledIndex(tabs, 0, -1));
    }
  }

  return (
    <div data-testid="page-tabs" className={cn("w-full", className)}>
      <div className="sm:hidden">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger
            aria-label={label}
            data-testid="page-tabs-select"
            className="min-h-11 bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {tabs.map((tab) => (
              <SelectItem
                key={tab.value}
                value={tab.value}
                disabled={tab.disabled}
                className="min-h-11"
              >
                {tab.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div
        role="tablist"
        aria-label={label}
        data-testid="page-tabs-list"
        onKeyDown={onKeyDown}
        className="hidden w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1 sm:flex"
      >
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = tab.value === value;
          return (
            <button
              key={tab.value}
              type="button"
              role="tab"
              id={`page-tab-${tab.value}`}
              ref={(node) => {
                tabRefs.current.set(tab.value, node);
              }}
              aria-selected={active}
              aria-controls={active ? panelId : undefined}
              tabIndex={active ? 0 : -1}
              disabled={tab.disabled}
              data-testid={`page-tab-${tab.value}`}
              onClick={() => onChange(tab.value)}
              className={cn(
                "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 sm:min-h-9 sm:px-4",
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              {Icon ? <Icon className="h-4 w-4" aria-hidden /> : null}
              {tab.label}
              {typeof tab.count === "number" ? (
                <span className="text-xs text-muted-foreground tabular-nums">{tab.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default PageTabs;
