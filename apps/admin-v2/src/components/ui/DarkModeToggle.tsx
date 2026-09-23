import { Moon, Sun } from "lucide-react";
import { cn } from "@scalius/shared/utils";
import { useTheme } from "~/components/admin/layout/ThemeProvider";

export function DarkModeToggle({ className }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const Icon = isDark ? Moon : Sun;

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label="Dark mode"
      onClick={toggleTheme}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:h-9 sm:w-9",
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-4" />
    </button>
  );
}
