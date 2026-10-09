import * as React from "react";

import { cn } from "@scalius/shared/utils";
import { formatDateTime, useMessages } from "~/i18n";
import { formMessages } from "~/i18n/forms";
import { formatDateOnly, parseDateOnly } from "~/lib/date-only";
import { useFieldControl } from "./field-context";
import { fieldClassName } from "./input";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";

// The calendar loads when a date field is opened, not with every screen that has one.
const Calendar = React.lazy(() => import("./calendar").then((module) => ({ default: module.Calendar })));

type DateInputProps = {
  /** A calendar day as "2026-10-07", or "" for none. */
  value: string;
  onValueChange: (value: string) => void;
  /** The earliest and latest day that can be picked, as "2026-10-07". */
  min?: string;
  max?: string;
  id?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
};

/**
 * A day, written with its month as a word ("Oct 7, 2026"), never "07/10/2026",
 * which reads as two different days in two countries. The value is the same
 * "YYYY-MM-DD" a native date field holds; the calendar opens below the field.
 */
export function DateInput(fieldProps: DateInputProps) {
  // Inside a `Field`, the button takes the field's id, help and invalid state.
  const { value, onValueChange, min, max, id, disabled = false, className, ...aria } = useFieldControl(fieldProps);
  const t = useMessages(formMessages);
  const [open, setOpen] = React.useState(false);
  const day = parseDateOnly(value);
  const earliest = parseDateOnly(min);
  const latest = parseDateOnly(max);
  // A calendar day has no time zone: write it as the same day everywhere.
  const label = day ? formatDateTime(new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate())), { dateStyle: "medium", timeZone: "UTC" }) : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={cn(fieldClassName, "flex h-11 items-center gap-2 py-1 text-start sm:h-9", className)}
          {...aria}
        >
          <span className={cn("min-w-0 flex-1 truncate", !label && "text-muted-foreground")}>{label ?? t("pickDate")}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <React.Suspense fallback={<div className="h-72 w-64" />}>
          <Calendar
            autoFocus
            mode="single"
            defaultMonth={day ?? earliest}
            selected={day}
            disabled={[...(earliest ? [{ before: earliest }] : []), ...(latest ? [{ after: latest }] : [])]}
            onSelect={(next) => {
              if (!next) return;
              onValueChange(formatDateOnly(next) ?? "");
              setOpen(false);
            }}
          />
        </React.Suspense>
        {value ? (
          <div className="flex justify-end border-t p-1.5">
            <button
              type="button"
              className="flex h-9 items-center gap-2 rounded-md px-3 text-body hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
              onClick={() => {
                onValueChange("");
                setOpen(false);
              }}
            >
              {t("clearDate")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
