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

interface QuickAddOption {
  label: string;
  value: string;
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
      const newItems = pasted
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s !== "" && !items.includes(s));

      if (newItems.length > 0) {
        onItemsChange([...items, ...newItems]);
      }
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      if (val.includes(",")) {
        const parts = val.split(",").map((s) => s.trim());
        const lastPart = parts.pop() || "";
        const newItems = parts.filter(
          (p) => p !== "" && !items.includes(p),
        );
        if (newItems.length > 0) {
          onItemsChange([...items, ...newItems]);
        }
        onInputValueChange(lastPart);
      } else {
        onInputValueChange(val);
      }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter" && inputValue.trim()) {
        e.preventDefault();
        if (!items.includes(inputValue.trim())) {
          onItemsChange([...items, inputValue.trim()]);
        }
        onInputValueChange("");
      }
    };

    return (
      <div className="space-y-3 bg-muted/20 p-4 rounded-lg border">
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
                onValueChange={(val) => {
                  const newItems = val.split(",");
                  const combined = [...new Set([...items, ...newItems])];
                  onItemsChange(combined);
                }}
              >
                <SelectTrigger className="h-7 text-[10px] w-[110px] border-dashed">
                  <SelectValue placeholder="Quick Add..." />
                </SelectTrigger>
                <SelectContent>
                  {quickAddOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
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
          className="h-10 bg-background"
        />

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
