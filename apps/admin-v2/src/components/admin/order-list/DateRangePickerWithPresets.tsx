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

import { cn } from "@scalius/shared/utils";
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
  initialOpen?: boolean;
}

const PRESETS = [
  {
    label: "Today",
    getValue: () => ({ from: startOfToday(), to: endOfToday() }),
  },
  {
    label: "Yesterday",
    getValue: () => {
      const d = subDays(startOfToday(), 1);
      return { from: d, to: d };
    },
  },
  {
    label: "Last 7 days",
    getValue: () => ({ from: subDays(startOfToday(), 6), to: startOfToday() }),
  },
  {
    label: "Last 30 days",
    getValue: () => ({ from: subDays(startOfToday(), 29), to: startOfToday() }),
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
      const m = subMonths(new Date(), 1);
      return { from: startOfMonth(m), to: endOfMonth(m) };
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
  initialOpen = false,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(initialOpen);
  const [tempDate, setTempDate] = React.useState<DateRange | undefined>(date);

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
          variant="outline"
          size="sm"
          className={cn(
            "justify-start text-left font-normal text-xs h-9 w-[240px]",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <CalendarIcon className="mr-2 h-3.5 w-3.5" />
          {date?.from ? (
            date.to ? (
              <>
                {format(date.from, "MMM d, yyyy")} –{" "}
                {format(date.to, "MMM d, yyyy")}
              </>
            ) : (
              format(date.from, "MMM d, yyyy")
            )
          ) : (
            <span>Pick a date range</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align={align} sideOffset={4}>
        <div className="flex bg-popover rounded-lg border shadow-lg overflow-hidden">
          {/* Presets */}
          <div className="flex flex-col gap-0.5 p-2 border-r min-w-[120px]">
            <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60 px-2 pb-1">
              Quick select
            </span>
            {PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => handlePresetSelect(preset)}
                className="text-left text-xs px-2 py-1.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Calendar + Footer */}
          <div className="flex flex-col">
            <Calendar
              autoFocus
              mode="range"
              defaultMonth={tempDate?.from}
              selected={tempDate}
              onSelect={setTempDate}
              numberOfMonths={2}
              className="p-2"
            />

            {/* Footer */}
            <div className="flex items-center justify-between px-3 py-2 border-t">
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="text-xs h-7 px-2 text-muted-foreground hover:text-destructive"
              >
                Reset
              </Button>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                  className="text-xs h-7 px-3"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleApply}
                  className="text-xs h-7 px-3"
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
