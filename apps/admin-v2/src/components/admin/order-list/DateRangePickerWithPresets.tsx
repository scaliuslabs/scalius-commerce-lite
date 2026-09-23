import { useEffect, useState, type ReactNode } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState<DateRange | undefined>(date);

  useEffect(() => {
    setDraft(date);
  }, [date, open]);

  const apply = (range: DateRange | undefined) => {
    setDate(range);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-wrap gap-1 border-b p-2 sm:flex-col sm:border-b-0 sm:border-r">
            {(Object.keys(DATE_PRESETS) as Array<keyof typeof DATE_PRESETS>).map((key) => (
              <Button key={key} variant="ghost" size="sm" onClick={() => apply(DATE_PRESETS[key]())}>
                {t(`preset.${key}`)}
              </Button>
            ))}
          </div>
          <div>
            <Calendar
              autoFocus
              mode="range"
              defaultMonth={draft?.from}
              selected={draft}
              onSelect={setDraft}
              numberOfMonths={1}
            />
            <div className="flex items-center justify-between gap-2 border-t p-2">
              <Button variant="ghost" size="sm" onClick={() => apply(undefined)}>
                {t("clearDates")}
              </Button>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
                  {tr("cancel")}
                </Button>
                <Button size="sm" onClick={() => apply(draft)}>
                  {t("apply")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
