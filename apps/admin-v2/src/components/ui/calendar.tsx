import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayButton } from "react-day-picker";

import { cn } from "@scalius/shared/utils";

const navButton =
  "flex size-8 items-center justify-center rounded-lg text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50";

function Calendar({ className, showOutsideDays = true, ...props }: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("w-fit p-3", className)}
      classNames={{
        months: "relative flex flex-col gap-4 md:flex-row",
        month: "flex w-full flex-col gap-4",
        nav: "absolute inset-x-0 top-0 flex w-full items-center justify-between gap-1",
        button_previous: navButton,
        button_next: navButton,
        month_caption: "flex h-8 w-full items-center justify-center px-8",
        caption_label: "select-none text-heading-sm",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday: "flex-1 select-none text-caption text-muted-foreground",
        week: "mt-1 flex w-full",
        day: "group/day relative aspect-square size-full select-none p-0 text-center",
        range_start: "rounded-l-lg bg-accent",
        range_middle: "rounded-none",
        range_end: "rounded-r-lg bg-accent",
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
      data-day={day.date.toLocaleDateString()}
      data-edge={selectedSingle || modifiers.range_start || modifiers.range_end || undefined}
      data-middle={modifiers.range_middle || undefined}
      className={cn(
        "flex aspect-square w-full min-w-9 items-center justify-center rounded-lg text-body tabular-nums hover:bg-accent focus-visible:relative focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "data-[middle]:rounded-none data-[middle]:bg-accent data-[edge]:bg-primary data-[edge]:text-primary-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Calendar };
