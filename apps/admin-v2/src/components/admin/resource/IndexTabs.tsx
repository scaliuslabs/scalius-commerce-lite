import { cn } from "@scalius/shared/utils";

export interface IndexTab<T extends string> {
  value: T;
  label: string;
}

interface IndexTabsProps<T extends string> {
  tabs: ReadonlyArray<IndexTab<T>>;
  value: T;
  onChange: (value: T) => void;
  label?: string;
}

/** Shopify-style view tabs across the top of a list card (All, Draft, Trash…). */
export function IndexTabs<T extends string>({ tabs, value, onChange, label }: IndexTabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b px-2 py-1.5">
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
              "min-h-11 shrink-0 rounded-md px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8",
              active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
