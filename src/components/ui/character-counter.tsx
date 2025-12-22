// Character counter component with SEO recommendations
import { cn } from "@/lib/utils";
import { AlertCircle, CheckCircle2, AlertTriangle } from "lucide-react";

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
  // Determine status and styling
  const getStatus = () => {
    if (current <= recommended) {
      return {
        icon: CheckCircle2,
        color: "text-green-600 dark:text-green-500",
        bgColor: "bg-green-50 dark:bg-green-950/30",
        message: `Good! ${current} ${label}`,
      };
    } else if (max && current <= max) {
      return {
        icon: AlertTriangle,
        color: "text-yellow-600 dark:text-yellow-500",
        bgColor: "bg-yellow-50 dark:bg-yellow-950/30",
        message: `${current} ${label} (recommended: ${recommended})`,
      };
    } else {
      return {
        icon: AlertCircle,
        color: "text-orange-600 dark:text-orange-500",
        bgColor: "bg-orange-50 dark:bg-orange-950/30",
        message: `${current} ${label} (recommended: ${recommended})`,
      };
    }
  };

  const status = getStatus();
  const Icon = status.icon;

  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium",
        status.bgColor,
        status.color,
        className,
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{status.message}</span>
    </div>
  );
}
