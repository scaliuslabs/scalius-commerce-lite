import { cn } from "@scalius/shared/utils";

interface CharacterCounterProps {
  current: number;
  recommended: number;
  max?: number;
  className?: string;
  label?: string;
}

export function CharacterCounter({
  current,
  recommended,
  max,
  className,
  label = "characters",
}: CharacterCounterProps) {
  const limit = max ?? recommended;

  return (
    <div
      aria-live="polite"
      className={cn(
        "text-right text-xs tabular-nums text-muted-foreground",
        current > recommended && "text-amber-700 dark:text-amber-400",
        max && current >= max && "text-destructive",
        className,
      )}
    >
      {current} / {limit} {label}
    </div>
  );
}
