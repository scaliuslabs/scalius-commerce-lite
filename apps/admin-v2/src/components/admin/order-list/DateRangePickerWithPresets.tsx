import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  endOfMonth,
  endOfToday,
  endOfYear,
  startOfMonth,
  startOfToday,
  startOfYear,
  subDays,
  subMonths,
} from "date-fns";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { OVERLAY_COLLISION_PADDING } from "@/components/ui/overlay";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useMediaQuery } from "~/hooks/use-media-query";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";
import { orderListMessages } from "~/i18n/order-list";

/** Quick ranges on Bangladesh calendar-day boundaries. */
export const DATE_PRESETS = {
  today: () => ({ from: startOfToday(), to: endOfToday() }),
  yesterday: () => {
    const day = subDays(startOfToday(), 1);
    return { from: day, to: day };
  },
  last7Days: () => ({ from: subDays(startOfToday(), 6), to: startOfToday() }),
  last30Days: () => ({ from: subDays(startOfToday(), 29), to: startOfToday() }),
  thisMonth: () => ({ from: startOfMonth(new Date()), to: endOfMonth(new Date()) }),
  lastMonth: () => {
    const month = subMonths(new Date(), 1);
    return { from: startOfMonth(month), to: endOfMonth(month) };
  },
  thisYear: () => ({ from: startOfYear(new Date()), to: endOfYear(new Date()) }),
} satisfies Record<string, () => DateRange>;

/** Phones: the picker is a bottom sheet with the presets above the calendar. */
export const COMPACT_DATE_PICKER_QUERY = "(max-width: 639px)";

/**
 * The popover's natural height with a six-week month (presets beside the
 * calendar, footer below). When neither side of the trigger has this much
 * room, it opens as a dialog instead of a popover with a scrolling calendar.
 */
const POPOVER_HEIGHT = 380;
const SIDE_OFFSET = 4;

/** Whether the popover fits above or below `trigger` without scrolling. */
function popoverFits(trigger: HTMLElement | null) {
  if (!trigger) return true;
  const rect = trigger.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - SIDE_OFFSET - OVERLAY_COLLISION_PADDING.bottom;
  const above = rect.top - SIDE_OFFSET - OVERLAY_COLLISION_PADDING.top;
  return Math.max(below, above) >= POPOVER_HEIGHT;
}

const PRESET_KEYS = Object.keys(DATE_PRESETS) as Array<keyof typeof DATE_PRESETS>;

/**
 * Presets apply at once; a custom range applies with Apply. As a popover it
 * opens below the trigger (above when only that side has room), clear of the
 * top bar, and is capped at the height Radix leaves: the presets and calendar
 * scroll and the Clear / Cancel / Apply footer stays visible. On phones, or
 * when neither side has room, it is a dialog with a pinned footer.
 */
export function DateRangePickerWithPresets({
  date,
  setDate,
  trigger,
}: {
  date: DateRange | undefined;
  setDate: (date: DateRange | undefined) => void;
  trigger: ReactNode;
}) {
  const t = useMessages(orderListMessages);
  const tr = useMessages(resourceMessages);
  const narrow = useMediaQuery(COMPACT_DATE_PICKER_QUERY);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [fits, setFits] = useState(true);
  const [draft, setDraft] = useState<DateRange | undefined>(date);
  const compact = narrow || !fits;

  // Decide the shape each time it opens, before paint, from where the trigger is.
  useLayoutEffect(() => {
    if (open) setFits(popoverFits(triggerRef.current));
  }, [open]);

  useEffect(() => {
    setDraft(date);
  }, [date, open]);

  const apply = (range: DateRange | undefined) => {
    setDate(range);
    setOpen(false);
  };

  const presetButtons = PRESET_KEYS.map((key) => (
    <Button key={key} variant="ghost" size="sm" className="justify-start" onClick={() => apply(DATE_PRESETS[key]())}>
      {t(`preset.${key}`)}
    </Button>
  ));
  const calendar = (
    <Calendar
      autoFocus
      mode="range"
      defaultMonth={draft?.from}
      selected={draft}
      onSelect={setDraft}
      numberOfMonths={1}
    />
  );
  const clear = (
    <Button variant="ghost" size="sm" onClick={() => apply(undefined)}>
      {t("clearDates")}
    </Button>
  );
  const cancelApply = (
    <div className="flex gap-2">
      <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
        {tr("cancel")}
      </Button>
      <Button size="sm" onClick={() => apply(draft)}>
        {t("apply")}
      </Button>
    </div>
  );

  if (compact) {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild ref={triggerRef}>
          {trigger}
        </DialogTrigger>
        <DialogContent aria-describedby={undefined} data-slot="date-range-picker" className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("date")}</DialogTitle>
          </DialogHeader>
          <div data-slot="date-range-presets" className="flex flex-wrap gap-1">
            {presetButtons}
          </div>
          <div className="flex justify-center">{calendar}</div>
          <DialogFooter data-slot="date-range-footer" className="flex-row items-center justify-between sm:justify-between">
            {clear}
            {cancelApply}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild ref={triggerRef}>
        {trigger}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="bottom"
        sideOffset={SIDE_OFFSET}
        data-slot="date-range-picker"
        className="flex max-h-(--radix-popover-content-available-height) w-auto flex-col overflow-hidden p-0"
      >
        <div data-slot="date-range-body" className="flex min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <div data-slot="date-range-presets" className="flex shrink-0 flex-col gap-1 border-r p-2">
            {presetButtons}
          </div>
          {calendar}
        </div>
        <div data-slot="date-range-footer" className="flex shrink-0 items-center justify-between gap-2 border-t p-2">
          {clear}
          {cancelApply}
        </div>
      </PopoverContent>
    </Popover>
  );
}
