import type { UseFormReturn } from "react-hook-form";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../../ui/form";
import { Button } from "../../../ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../../ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/popover";
import { Calendar } from "../../../ui/calendar";
import { CalendarIcon } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { formatDateShort } from "@scalius/shared/timestamps";
import type { FormValues } from "./types";

interface ActiveDatesSectionProps {
  form: UseFormReturn<FormValues>;
}

export function ActiveDatesSection({ form }: ActiveDatesSectionProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Active Dates</CardTitle>
        <CardDescription>
          Schedule when the discount is available.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        <div className="grid grid-cols-1 gap-x-4 gap-y-6 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="startDate"
            render={({ field }) => (
              <FormItem className="flex flex-col">
                <FormLabel>Start Date *</FormLabel>
                <Popover>
                  <PopoverTrigger asChild>
                    <FormControl>
                      <Button
                        variant={"outline"}
                        className={cn(
                          "w-full justify-start text-left font-normal",
                          !field.value && "text-muted-foreground",
                        )}
                      >
                        <CalendarIcon className="mr-2 h-4 w-4" />
                        {field.value &&
                          !isNaN(new Date(field.value).getTime()) ? (
                          <span suppressHydrationWarning>
                            {formatDateShort(field.value)}
                          </span>
                        ) : (
                          <span>Pick a date</span>
                        )}
                      </Button>
                    </FormControl>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={
                        field.value instanceof Date &&
                          !isNaN(field.value.getTime())
                          ? field.value
                          : undefined
                      }
                      onSelect={(date) =>
                        field.onChange(date || new Date())
                      }
                      autoFocus
                    />
                  </PopoverContent>
                </Popover>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="endDate"
            render={({ field }) => {
              const startDate = form.getValues("startDate");
              return (
                <FormItem className="flex flex-col">
                  <FormLabel>End Date</FormLabel>
                  <Popover>
                    <PopoverTrigger asChild>
                      <FormControl>
                        <Button
                          variant={"outline"}
                          className={cn(
                            "w-full justify-start text-left font-normal",
                            !field.value && "text-muted-foreground",
                          )}
                        >
                          <CalendarIcon className="mr-2 h-4 w-4" />
                          {field.value &&
                            !isNaN(new Date(field.value).getTime()) ? (
                            <span suppressHydrationWarning>
                              {formatDateShort(field.value)}
                            </span>
                          ) : (
                            <span>No end date</span>
                          )}
                        </Button>
                      </FormControl>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={
                          field.value instanceof Date &&
                            !isNaN(field.value.getTime())
                            ? field.value
                            : undefined
                        }
                        onSelect={(date) => field.onChange(date)}
                        autoFocus
                        disabled={(date) => {
                          return startDate && !isNaN(startDate.getTime())
                            ? date < startDate
                            : false;
                        }}
                      />
                      {field.value ? (
                        <div className="p-2 border-t border-border">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="w-full justify-center"
                            onClick={() => field.onChange(null)}
                          >
                            Clear end date
                          </Button>
                        </div>
                      ) : null}
                    </PopoverContent>
                  </Popover>
                  <FormDescription>
                    Optional. Discount expires at 11:59 PM on this day.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              );
            }}
          />
        </div>
      </CardContent>
    </Card>
  );
}
