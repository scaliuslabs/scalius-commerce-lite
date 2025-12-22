import { format } from "date-fns";
import { Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface TimePickerProps {
  date: Date | undefined;
  setDate: (date: Date | undefined) => void;
  className?: string;
}

export function TimePicker({ date, setDate, className }: TimePickerProps) {
  // Generate hours (1-12)
  const hours = Array.from({ length: 12 }, (_, i) => i + 1);

  // Generate minutes (00-55 in increments of 5)
  const minutes = Array.from({ length: 12 }, (_, i) => i * 5);

  // Get current hour, minute, and am/pm from date
  const currentHour = date ? format(date, "h") : "12";
  const currentMinute = date ? format(date, "mm") : "00";
  const currentPeriod = date ? format(date, "a") : "AM";

  // Update time when any of the selects change
  const handleTimeChange = (
    type: "hour" | "minute" | "period",
    value: string,
  ) => {
    const newDate = date ? new Date(date) : new Date();

    if (type === "hour") {
      let hour = parseInt(value);

      // Convert to 24-hour format if needed
      if (currentPeriod === "PM" && hour < 12) {
        hour += 12;
      } else if (currentPeriod === "AM" && hour === 12) {
        hour = 0;
      }

      newDate.setHours(hour);
    } else if (type === "minute") {
      newDate.setMinutes(parseInt(value));
    } else if (type === "period") {
      let hour = newDate.getHours();

      if (value === "AM" && hour >= 12) {
        newDate.setHours(hour - 12);
      } else if (value === "PM" && hour < 12) {
        newDate.setHours(hour + 12);
      }
    }

    setDate(newDate);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant={"outline"}
          className={cn(
            "w-full justify-start text-left font-normal",
            !date && "text-muted-foreground",
            className,
          )}
        >
          <Clock className="mr-2 h-4 w-4" />
          {date ? format(date, "h:mm a") : <span>Pick a time</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-4">
        <div className="flex items-center space-x-2">
          {/* Hour select */}
          <Select
            value={currentHour}
            onValueChange={(value) => handleTimeChange("hour", value)}
          >
            <SelectTrigger className="w-16">
              <SelectValue placeholder="Hour" />
            </SelectTrigger>
            <SelectContent>
              {hours.map((hour) => (
                <SelectItem key={hour} value={hour.toString()}>
                  {hour}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <span>:</span>

          {/* Minute select */}
          <Select
            value={currentMinute}
            onValueChange={(value) => handleTimeChange("minute", value)}
          >
            <SelectTrigger className="w-16">
              <SelectValue placeholder="Min" />
            </SelectTrigger>
            <SelectContent>
              {minutes.map((minute) => (
                <SelectItem
                  key={minute}
                  value={minute.toString().padStart(2, "0")}
                >
                  {minute.toString().padStart(2, "0")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* AM/PM select */}
          <Select
            value={currentPeriod}
            onValueChange={(value) => handleTimeChange("period", value)}
          >
            <SelectTrigger className="w-16">
              <SelectValue placeholder="AM/PM" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="AM">AM</SelectItem>
              <SelectItem value="PM">PM</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}
