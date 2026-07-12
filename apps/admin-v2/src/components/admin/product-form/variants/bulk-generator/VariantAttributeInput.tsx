import React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";

function optionIdentity(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

function appendUniqueOptions(current: string[], candidates: readonly string[]): string[] {
  const seen = new Set(current.map(optionIdentity));
  const next = [...current];

  for (const candidate of candidates) {
    const displayValue = candidate.trim();
    const identity = optionIdentity(displayValue);
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    next.push(displayValue);
  }

  return next;
}

interface QuickAddOption {
  label: string;
  values: readonly string[];
}

interface VariantAttributeInputProps {
  id: string;
  label: string;
  items: string[];
  onItemsChange: (items: string[]) => void;
  inputValue: string;
  onInputValueChange: (value: string) => void;
  placeholder: string;
  emptyMessage: string;
  quickAddOptions?: QuickAddOption[];
}

export const VariantAttributeInput = React.memo(
  function VariantAttributeInput({
    id,
    label,
    items,
    onItemsChange,
    inputValue,
    onInputValueChange,
    placeholder,
    emptyMessage,
    quickAddOptions,
  }: VariantAttributeInputProps) {
    const handleRemove = (item: string) => {
      onItemsChange(items.filter((i) => i !== item));
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
      e.preventDefault();
      const pasted = e.clipboardData.getData("text");
      if (!pasted) return;
      onItemsChange(appendUniqueOptions(items, pasted.split(/[\n,;\t]+/)));
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (val.includes(",")) {
        const parts = val.split(",").map((s) => s.trim());
        const lastPart = parts.pop() || "";
        onItemsChange(appendUniqueOptions(items, parts));
        onInputValueChange(lastPart);
      } else {
        onInputValueChange(val);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && inputValue.trim()) {
        e.preventDefault();
        onItemsChange(appendUniqueOptions(items, [inputValue]));
        onInputValueChange("");
      } else if (e.key === "Backspace" && !inputValue && items.length > 0) {
        onItemsChange(items.slice(0, -1));
      }
    };

    return (
      <div className="space-y-2.5 rounded-lg border bg-background p-3">
        <div className="flex items-center justify-between">
          <Label
            htmlFor={id}
            className="text-sm font-semibold flex items-center gap-2"
          >
            {label}
            <Badge
              variant="outline"
              className="text-[10px] font-normal h-5"
            >
              {items.length} added
            </Badge>
          </Label>
          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onItemsChange([])}
                className="h-6 text-[10px] text-muted-foreground hover:text-destructive px-2"
              >
                Clear All
              </Button>
            )}
            {quickAddOptions && (
              <Select
                onValueChange={(value) => {
                  const option = quickAddOptions[Number(value)];
                  if (option) onItemsChange(appendUniqueOptions(items, option.values));
                }}
              >
                <SelectTrigger className="h-7 text-[10px] w-[110px] border-dashed">
                  <SelectValue placeholder="Quick Add..." />
                </SelectTrigger>
                <SelectContent>
                  {quickAddOptions.map((option, index) => (
                    <SelectItem key={`${option.label}-${index}`} value={String(index)}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <Input
          id={id}
          value={inputValue}
          onPaste={handlePaste}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="h-9 bg-background"
          aria-describedby={`${id}-help`}
        />

        <p id={`${id}-help`} className="text-[11px] leading-4 text-muted-foreground">
          Press Enter after each value, or paste rows separated by commas, tabs,
          semicolons, or new lines.
        </p>

        {items.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 min-h-6">
            {items.map((item) => (
              <Badge
                key={item}
                variant="secondary"
                className="gap-1 pl-2.5 pr-1 py-0.5 text-sm"
              >
                {item}
                <button
                  type="button"
                  onClick={() => handleRemove(item)}
                  aria-label={`Remove ${item}`}
                  className="ml-1 ring-offset-background rounded-full outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 hover:bg-destructive hover:text-destructive-foreground transition-colors p-0.5"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
          </div>
        ) : (
          <p className="text-[12px] text-muted-foreground italic pl-1">
            {emptyMessage}
          </p>
        )}
      </div>
    );
  },
);
