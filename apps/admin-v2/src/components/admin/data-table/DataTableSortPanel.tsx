// The sort menu's controls: the field, then the direction. Loaded when the
// menu first opens, or on hover or focus of its button.
import { ArrowDown, ArrowUp } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { dataTableMessages } from "~/i18n/data-table";
import type { SortMenuProps } from "./DataTableSortMenu";

/** The radio value of the list's own order. */
const DEFAULT_SORT = "__default";

export function SortPanel({ fields, value, defaultLabel, onChange }: SortMenuProps) {
  const t = useMessages(dataTableMessages);
  const field = value ? fields.find((candidate) => candidate.id === value.id) : undefined;
  const directionless = field?.directions === 1;
  return (
    <div className="space-y-2 p-3">
      <h2 id="table-sort-heading" className="text-body font-medium">{t("sortBy")}</h2>
      <RadioGroup
        aria-labelledby="table-sort-heading"
        value={field?.id ?? (defaultLabel === false ? "" : DEFAULT_SORT)}
        onValueChange={(id) => {
          if (id === DEFAULT_SORT) return onChange(null);
          const next = fields.find((candidate) => candidate.id === id);
          onChange({ id, desc: next?.directions === 1 ? Boolean(next.desc) : value?.desc ?? Boolean(next?.desc) });
        }}
      >
        {/* The list's own order, so the current sort is always one of the choices. */}
        {defaultLabel === false ? null : (
          <div className="flex min-h-9 items-center gap-2">
            <RadioGroupItem value={DEFAULT_SORT} id="table-sort-default" />
            <Label htmlFor="table-sort-default">{defaultLabel ?? t("defaultSort")}</Label>
          </div>
        )}
        {fields.map((candidate) => (
          <div key={candidate.id} className="flex min-h-9 items-center gap-2">
            <RadioGroupItem value={candidate.id} id={`table-sort-${candidate.id}`} />
            <Label htmlFor={`table-sort-${candidate.id}`}>{candidate.label}</Label>
          </div>
        ))}
      </RadioGroup>
      {directionless ? null : (
        <div className="grid grid-cols-2 gap-2 border-t pt-2">
          {([false, true] as const).map((desc) => (
            <Button
              key={String(desc)}
              type="button"
              size="sm"
              variant={field && Boolean(value?.desc) === desc ? "secondary" : "ghost"}
              aria-pressed={Boolean(field) && Boolean(value?.desc) === desc}
              disabled={!field}
              onClick={() => field && onChange({ id: field.id, desc })}
            >
              {desc ? <ArrowDown /> : <ArrowUp />}
              {(desc ? field?.descLabel : field?.ascLabel) ?? t(desc ? "descending" : "ascending")}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
