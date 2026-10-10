import { useEffect, useState } from "react";
import { CalendarDays, Check } from "lucide-react";
import type { DateRange } from "react-day-picker";
import {
  ANALYTICS_MAX_RANGE_DAYS,
  ANALYTICS_PRESETS,
  analyticsPresetFor,
  analyticsPresetRange,
  analyticsRangeDays,
  type AnalyticsPreset,
  type AnalyticsRange,
} from "@scalius/shared/analytics-period";
import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/ui/popover";
import { useMediaQuery } from "~/hooks/use-media-query";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import { useMessages } from "~/i18n";
import { analyticsMessages } from "~/i18n/analytics";
import { formatRangeLabel } from "./analytics-format";

/** Phones: the picker is a dialog with the presets above the calendar. */
const COMPACT_PICKER_QUERY = "(max-width: 639px)";

/** The trigger's words: the preset's name while the range is one, else its dates. */
export function useAnalyticsRangeLabel(range: AnalyticsRange, today: string): string {
  const t = useMessages(analyticsMessages);
  const preset = analyticsPresetFor(range, today);
  return preset ? t(`preset.${preset}`) : formatRangeLabel(range);
}

/**
 * Shopify's date picker: presets as rows (applied at once), or a custom range
 * on the calendar applied with Apply. A popover beside the toolbar; a dialog
 * with a pinned footer on phones. Days are store-calendar days.
 */
export function AnalyticsRangePicker({
  range,
  today,
  onChange,
}: {
  range: AnalyticsRange;
  today: string;
  onChange: (range: AnalyticsRange) => void;
}) {
  const t = useMessages(analyticsMessages);
  const compact = useMediaQuery(COMPACT_PICKER_QUERY);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const label = useAnalyticsRangeLabel(range, today);
  const active = analyticsPresetFor(range, today);

  useEffect(() => {
    if (open) setDraft({ from: parseDateOnly(range.from), to: parseDateOnly(range.to) });
  }, [open, range.from, range.to]);

  const draftRange = draft?.from
    ? { from: formatDateOnly(draft.from)!, to: formatDateOnly(draft.to ?? draft.from)! }
    : null;
  const tooLong = draftRange ? analyticsRangeDays(draftRange) > ANALYTICS_MAX_RANGE_DAYS : false;

  const choose = (next: AnalyticsRange) => {
    onChange(next);
    setOpen(false);
  };

  const presets = (
    <ul data-slot="analytics-range-presets" className="flex flex-col gap-0.5" aria-label={t("dateRange")}>
      {ANALYTICS_PRESETS.map((preset: AnalyticsPreset) => (
        <li key={preset}>
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-between"
            aria-pressed={active === preset}
            onClick={() => choose(analyticsPresetRange(preset, today))}
          >
            <span>{t(`preset.${preset}`)}</span>
            {active === preset ? <Check className="size-4" aria-hidden /> : <span className="size-4" aria-hidden />}
          </Button>
        </li>
      ))}
    </ul>
  );
  const calendar = (
    <Calendar
      mode="range"
      defaultMonth={draft?.from}
      selected={draft}
      onSelect={setDraft}
      disabled={{ after: parseDateOnly(today)! }}
      numberOfMonths={1}
    />
  );
  const summary = (
    <p className={tooLong ? "text-body text-destructive" : "text-body text-muted-foreground"}>
      {tooLong ? t("rangeTooLong") : draftRange ? formatRangeLabel(draftRange) : t("customRange")}
    </p>
  );
  const actions = (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t("cancel")}</Button>
      <Button size="sm" disabled={!draftRange || tooLong} onClick={() => draftRange && choose(draftRange)}>
        {t("apply")}
      </Button>
    </div>
  );
  // Toolbar height, beside the toolbar's selects (C2).
  const trigger = (
    <Button variant="outline">
      <CalendarDays className="size-4" aria-hidden />
      <span>{label}</span>
    </Button>
  );

  if (compact) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>{trigger}</DialogTrigger>
        <DialogContent aria-describedby={undefined} data-slot="analytics-range-picker" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("dateRange")}</DialogTitle>
          </DialogHeader>
          {presets}
          <div className="flex justify-center border-t pt-2">{calendar}</div>
          <DialogFooter data-slot="analytics-range-footer" className="flex-row items-center justify-between sm:justify-between">
            {summary}
            {actions}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={4}
        data-slot="analytics-range-picker"
        className="flex max-h-(--radix-popover-content-available-height) w-auto flex-col overflow-hidden p-0"
      >
        <div className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div className="w-44 shrink-0 border-e p-2">{presets}</div>
          {calendar}
        </div>
        <div data-slot="analytics-range-footer" className="flex shrink-0 items-center justify-between gap-3 border-t p-2">
          {summary}
          {actions}
        </div>
      </PopoverContent>
    </Popover>
  );
}
