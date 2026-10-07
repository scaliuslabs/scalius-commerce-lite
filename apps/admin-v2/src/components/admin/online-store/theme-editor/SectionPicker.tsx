import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import type { SearchableSelectOption } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { comboboxMessages } from "~/i18n/combobox";
import { onlineStoreMessages } from "~/i18n/online-store";

/** Small, local layout thumbnails: no network images or initial dashboard assets. */
function SectionThumbnail({ type }: { type: string }) {
  const tiles = ["category-tiles", "product-rail", "collection-tabs"].includes(type);
  const copy = ["rich-text", "faq", "newsletter", "trust-strip"].includes(type);
  return (
    <svg data-section-thumbnail={type} viewBox="0 0 80 48" className="h-12 w-20 shrink-0 rounded-md bg-muted text-muted-foreground" aria-hidden="true">
      {tiles ? [6, 31, 56].map((x) => <rect key={x} x={x} y="8" width="18" height="28" rx="2" fill="currentColor" opacity="0.3" />)
        : copy ? <><rect x="10" y="10" width="40" height="4" rx="2" fill="currentColor" /><rect x="10" y="20" width="60" height="3" rx="1" fill="currentColor" opacity="0.4" /><rect x="10" y="28" width="52" height="3" rx="1" fill="currentColor" opacity="0.4" /><rect x="10" y="36" width="32" height="3" rx="1" fill="currentColor" opacity="0.4" /></>
          : <><rect x="6" y="6" width={type === "split-banner" ? "32" : "68"} height="36" rx="2" fill="currentColor" opacity="0.3" /><rect x={type === "split-banner" ? "44" : "16"} y="20" width="24" height="4" rx="2" fill="currentColor" /><rect x={type === "split-banner" ? "44" : "16"} y="29" width="18" height="3" rx="1" fill="currentColor" opacity="0.6" /></>}
    </svg>
  );
}

export function SectionPicker({ options, disabled, onAdd }: {
  options: readonly SearchableSelectOption[];
  disabled: boolean;
  onAdd: (value: string) => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const combo = useMessages(comboboxMessages);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const visible = options.filter((option) => `${option.label} ${option.description ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const groups = [...new Set(visible.map((option) => option.group))];
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="w-full" aria-label={t("addSection")} disabled={disabled}>
          <Plus aria-hidden="true" />{t("addSection")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 max-h-(--radix-popover-content-available-height) flex-col gap-2 p-2">
        <Input value={search} aria-label={combo("search")} placeholder={combo("search")} onChange={(event) => setSearch(event.target.value)} autoFocus />
        <div role="listbox" aria-label={t("addSection")} className="min-h-0 overflow-y-auto" onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
          if (!options.length) return;
          event.preventDefault();
          const index = options.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }}>
          {visible.length === 0 ? <p className="px-2 py-2 text-body text-muted-foreground">{combo("empty")}</p> : null}
          {groups.map((group) => (
            <div key={group ?? "sections"}>
              {group ? <p role="presentation" className="px-2 py-1 text-body font-medium">{group}</p> : null}
              {visible.filter((option) => option.group === group).map((option) => (
                <button key={option.value} type="button" role="option" aria-selected="false" disabled={option.disabled}
                  className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-start text-body hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  onClick={() => { onAdd(option.value); setOpen(false); setSearch(""); }}>
                  <SectionThumbnail type={option.value} />
                  <span className="min-w-0"><span className="block font-medium">{option.label}</span>{option.description ? <span className="block text-muted-foreground">{option.description}</span> : null}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
