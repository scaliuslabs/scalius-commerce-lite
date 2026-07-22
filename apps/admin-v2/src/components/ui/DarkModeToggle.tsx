import * as React from "react";
import { Sun, Moon } from "lucide-react";
import { cn } from "@scalius/shared/utils";

export function DarkModeToggle({ className = "" }: { className?: string }) {
  // Start as null to avoid FOUC — don't render icons until we know the theme
  const [isDark, setIsDark] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    // Read the actual state from the DOM (already set by the inline theme script)
    const dark = document.documentElement.classList.contains("dark");
    setIsDark(dark);
  }, []);

  const toggleTheme = React.useCallback(() => {
    const root = document.documentElement;
    if (root.classList.contains("dark")) {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
      setIsDark(false);
    } else {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
      setIsDark(true);
    }
  }, []);

  // Don't render until we know the actual theme — prevents flash
  if (isDark === null) {
    return (
      <div
        aria-hidden="true"
        className={cn("h-11 w-11 shrink-0 sm:h-9 sm:w-9", className)}
      />
    );
  }

  return (
    <button
      type="button"
      role="switch"
      aria-checked={isDark}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={toggleTheme}
      className={cn(
        "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:h-9 sm:w-9",
        className,
      )}
    >
      <Sun
        aria-hidden="true"
        className={cn(
          "absolute h-[1.1rem] w-[1.1rem] text-amber-500 transition-all duration-200 dark:text-amber-300",
          isDark ? "scale-50 rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
        )}
      />
      <Moon
        aria-hidden="true"
        className={cn(
          "absolute h-[1.1rem] w-[1.1rem] text-indigo-600 transition-all duration-200 dark:text-indigo-300",
          isDark ? "scale-100 rotate-0 opacity-100" : "scale-50 -rotate-90 opacity-0",
        )}
      />
    </button>
  );
}
