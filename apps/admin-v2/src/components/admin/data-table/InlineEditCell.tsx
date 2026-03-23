import { useState, useEffect } from "react";
import { Input } from "@/components/ui/input";
import { useDebounce } from "@/hooks/use-debounce";
import { Loader2 } from "lucide-react";

interface InlineEditCellProps {
  value: string;
  onSave: (newValue: string) => void;
  disabled?: boolean;
  isSaving?: boolean;
  debounceMs?: number;
  minLength?: number;
  placeholder?: string;
  className?: string;
}

export function InlineEditCell({
  value,
  onSave,
  disabled = false,
  isSaving = false,
  debounceMs = 700,
  minLength = 2,
  placeholder,
  className,
}: InlineEditCellProps) {
  const [localValue, setLocalValue] = useState(value);
  const debouncedValue = useDebounce(localValue, debounceMs);

  // Sync external value changes
  useEffect(() => {
    setLocalValue(value);
  }, [value]);

  // Save on debounced change
  useEffect(() => {
    if (
      debouncedValue !== value &&
      debouncedValue.length >= minLength
    ) {
      onSave(debouncedValue);
    }
  }, [debouncedValue, value, minLength, onSave]);

  return (
    <div className="relative flex items-center">
      <Input
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={className ?? "h-8 text-sm"}
      />
      {isSaving && (
        <Loader2 className="absolute right-2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
      )}
    </div>
  );
}
