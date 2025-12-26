"use client";

import * as React from "react";
import {
  format,
  subDays,
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfYear,
  endOfYear,
  startOfToday,
  endOfToday,
} from "date-fns";
import { Calendar as CalendarIcon } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface DateRangePickerProps {
  date: DateRange | undefined;
  setDate: (date: DateRange | undefined) => void;
  className?: string;
  align?: "center" | "start" | "end";
}

const PRESETS = [
  {
    label: "Today",
    getValue: () => ({
      from: startOfToday(),
      to: endOfToday(),
    }),
  },
  {
    label: "Yesterday",
    getValue: () => {
      const yesterday = subDays(new Date(), 1);
      return {
        from: yesterday,
        to: yesterday,
      };
    },
  },
  {
    label: "Last 7 days",
    getValue: () => ({
      from: subDays(new Date(), 7),
      to: new Date(),
    }),
  },
  {
    label: "Last 30 days",
    getValue: () => ({
      from: subDays(new Date(), 30),
      to: new Date(),
    }),
  },
  {
    label: "This Month",
    getValue: () => ({
      from: startOfMonth(new Date()),
      to: endOfMonth(new Date()),
    }),
  },
  {
    label: "Last Month",
    getValue: () => {
      const lastMonth = subMonths(new Date(), 1);
      return {
        from: startOfMonth(lastMonth),
        to: endOfMonth(lastMonth),
      };
    },
  },
  {
    label: "This Year",
    getValue: () => ({
      from: startOfYear(new Date()),
      to: endOfYear(new Date()),
    }),
  },
];

export function DateRangePickerWithPresets({
  date,
  setDate,
  className,
  align = "start",
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);
  // Internal state to hold selection before applying
  const [tempDate, setTempDate] = React.useState<DateRange | undefined>(date);

  // Reset temp date when opening or when prop changes
  React.useEffect(() => {
    setTempDate(date);
  }, [date, open]);

  const handleApply = () => {
    setDate(tempDate);
    setOpen(false);
  };

  const handleReset = () => {
    setDate(undefined);
    setTempDate(undefined);
    setOpen(false);
  };

  const handlePresetSelect = (preset: (typeof PRESETS)[0]) => {
    const newRange = preset.getValue();
    setDate(newRange);
    setTempDate(newRange);
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id="date"
          variant={"outline"}
          size="sm"
          className={cn(
            "justify-start text-left font-normal text-xs h-9 w-[260px]",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {date?.from ? (
            date.to ? (
              <>
                {format(date.from, "LLL dd, y")} -{" "}
                {format(date.to, "LLL dd, y")}
              </>
            ) : (
              format(date.from, "LLL dd, y")
            )
          ) : (
            <span>Pick a date range</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0 border-0 shadow-xl" align={align}>
        {/* Solid Card Wrapper */}
        <div className="flex flex-col sm:flex-row bg-popover border rounded-md overflow-hidden">
          {/* Presets Sidebar - Compact and integrated */}
          <div className="flex flex-col gap-0.5 p-2 border-b sm:border-b-0 sm:border-r border-border/50 min-w-[130px] bg-muted/10">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/70 mb-1.5 px-2 py-0.5">
              Presets
            </div>
            {PRESETS.map((preset) => (
              <Button
                key={preset.label}
                variant="ghost"
                size="sm"
                onClick={() => handlePresetSelect(preset)}
                className="justify-start text-[11px] font-medium h-7 px-2 hover:bg-muted/60 hover:text-foreground"
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Calendar Area - Compact mode */}
          <div className="p-0">
            <div className="p-2">
              <Calendar
                initialFocus
                mode="range"
                defaultMonth={tempDate?.from}
                selected={tempDate}
                onSelect={setTempDate}
                numberOfMonths={2}
                className="p-1" // Compact padding for calendar itself
                classNames={{
                  months: "flex flex-col sm:flex-row gap-3", // Tighter gap between months
                  month: "flex flex-col gap-3", // Tighter gap within month
                  caption:
                    "flex justify-center pt-1 relative items-center w-full pb-1", // Compact caption
                  caption_label: "text-xs font-semibold", // Smaller caption text
                  nav_button:
                    "size-6 bg-transparent p-0 opacity-50 hover:opacity-100", // Smaller nav buttons
                  head_cell:
                    "text-muted-foreground rounded-md w-7 font-normal text-[0.7rem]", // Smaller head cells
                  cell: "h-7 w-7 text-center text-[0.75rem] p-0 relative [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20", // Compact cells
                  day: "size-7 p-0 font-normal aria-selected:opacity-100 hover:bg-accent hover:text-accent-foreground rounded-md focus:bg-accent focus:text-accent-foreground", // Smaller day buttons
                  day_selected:
                    "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
                  day_today: "bg-accent/50 text-accent-foreground",
                  day_outside:
                    "text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
                  day_disabled: "text-muted-foreground opacity-50",
                  day_range_middle:
                    "aria-selected:bg-accent aria-selected:text-accent-foreground",
                  day_hidden: "invisible",
                }}
              />
            </div>

            {/* Actions Footer */}
            <div className="flex items-center justify-between p-2 border-t border-border/50 bg-muted/5">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="text-[11px] h-7 px-2 text-muted-foreground hover:text-destructive hover:bg-destructive/5"
              >
                Reset
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="text-[11px] h-7 px-3 hover:bg-muted"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleApply}
                  className="text-[11px] h-7 px-3 shadow-sm bg-primary hover:bg-primary/90 transition-all active:scale-95"
                >
                  Apply
                </Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
