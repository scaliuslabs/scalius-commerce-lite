import * as React from "react";
import { Sun, Moon } from "lucide-react";
import { Switch } from "./switch";

export function DarkModeToggle({ className = "" }: { className?: string }) {
  // SSR-safe: check for window
  const [isDark, setIsDark] = React.useState(false);

  React.useEffect(() => {
    const root = window.document.documentElement;
    const stored = localStorage.getItem("theme");
    // Default to light mode
    if (stored === "dark") {
      root.classList.add("dark");
      setIsDark(true);
    } else {
      root.classList.remove("dark");
      setIsDark(false);
    }
  }, []);

  const toggleTheme = React.useCallback(() => {
    const root = window.document.documentElement;
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

  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2 mr-3">
        <div className="relative h-5 w-5 flex items-center justify-center">
          <Sun
            className={`absolute h-[1.1rem] w-[1.1rem] text-yellow-500 dark:text-yellow-300 transition-all duration-300 ${
              isDark
                ? "opacity-0 scale-50 rotate-90"
                : "opacity-100 scale-100 rotate-0"
            }`}
          />
          <Moon
            className={`absolute h-[1.1rem] w-[1.1rem] text-indigo-600 dark:text-indigo-300 transition-all duration-300 ${
              isDark
                ? "opacity-100 scale-100 rotate-0"
                : "opacity-0 scale-50 rotate-90"
            }`}
          />
        </div>
      </div>
      <Switch
        checked={isDark}
        onCheckedChange={toggleTheme}
        aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
        className={`${isDark ? "bg-indigo-600 border-indigo-300" : "bg-gray-200 border-yellow-400"}`}
      />
    </div>
  );
}
