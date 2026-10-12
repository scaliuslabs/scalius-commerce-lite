import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayButton } from "react-day-picker";

import { weekStartDay } from "@scalius/shared/week-start";
import { cn } from "@scalius/shared/utils";
import { formatDateTime, formatNumber, useLocale, useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { getStoreRegion } from "~/lib/store-time-zone";

const navButton =
  "flex size-11 items-center justify-center rounded-lg text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50 sm:size-8";

/**
 * The date picker. Weeks start on the store country's first day (CLDR:
 * Sunday in Bangladesh and the US, Monday in most of Europe), and arrows
 * follow the page's direction (`<html dir>`, set with the dashboard language).
 */
function Calendar({ className, showOutsideDays = true, formatters, labels, ...props }: React.ComponentProps<typeof DayPicker>) {
  const locale = useLocale();
  const t = useMessages(formMessages);
  const monthLabel = (date: Date) => calendarDate(date, { month: "long", year: "numeric" });
  const dayLabel = (date: Date) => calendarDate(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      weekStartsOn={weekStartDay(getStoreRegion(), locale)}
      formatters={{
        formatCaption: monthLabel,
        formatDay: (date) => formatNumber(date.getDate()),
        formatWeekdayName: (date) => calendarDate(date, { weekday: "narrow" }),
        ...formatters,
      }}
      labels={{
        labelNav: () => t("calendarNavigation"),
        labelPrevious: () => t("calendarPreviousMonth"),
        labelNext: () => t("calendarNextMonth"),
        labelGrid: monthLabel,
        labelWeekday: (date) => calendarDate(date, { weekday: "long" }),
        labelGridcell: (date, modifiers) => modifiers?.today ? t("calendarTodayDate", { date: dayLabel(date) }) : dayLabel(date),
        labelDayButton: (date, modifiers) => {
          let label = dayLabel(date);
          if (modifiers.today) label = t("calendarTodayDate", { date: label });
          if (modifiers.selected) label = t("calendarSelectedDate", { date: label });
          return label;
        },
        ...labels,
      }}
      dir={typeof document === "undefined" ? undefined : document.documentElement.dir}
      className={cn("w-fit p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4 md:flex-row",
        month: "flex w-full flex-col gap-4",
        nav: "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
        button_previous: navButton,
        button_next: navButton,
        month_caption: "flex h-11 w-full items-center justify-center px-11 sm:h-8 sm:px-8",
        caption_label: "select-none text-heading-sm",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "flex-1 select-none text-caption text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "group/day relative size-full select-none p-0 text-center sm:aspect-square",
        range_start: "rounded-s-lg bg-accent",
        range_middle: "rounded-none",
        range_end: "rounded-e-lg bg-accent",
        today: "rounded-lg bg-accent",
        outside: "text-muted-foreground",
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === "left" ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />,
        DayButton: CalendarDayButton,
      }}
      {...props}
    />
  );
}

/** Calendar days keep their date even when the store and browser zones differ. */
function calendarDate(date: Date, options: Intl.DateTimeFormatOptions) {
  const day = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  return formatDateTime(day, { ...options, timeZone: "UTC" });
}

function CalendarDayButton({ className, day, modifiers, ...props }: React.ComponentProps<typeof DayButton>) {
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);

  const selectedSingle = modifiers.selected && !modifiers.range_start && !modifiers.range_end && !modifiers.range_middle;

  return (
    <button
      ref={ref}
      type="button"
      data-day={day.isoDate}
      data-edge={selectedSingle || modifiers.range_start || modifiers.range_end || undefined}
      data-middle={modifiers.range_middle || undefined}
      className={cn(
        "flex h-11 w-full min-w-9 items-center justify-center rounded-lg text-body tabular-nums hover:bg-accent focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:aspect-square sm:h-auto",
        "data-[middle]:rounded-none data-[middle]:bg-accent data-[edge]:bg-primary data-[edge]:text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Calendar };
