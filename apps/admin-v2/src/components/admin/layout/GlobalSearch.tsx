import { lazy, Suspense, useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import type { GlobalSearchProps } from "./GlobalSearchDialog";

// The command palette (cmdk) loads on first use, keeping it out of the shell chunk.
const GlobalSearchDialog = lazy(() =>
  import("./GlobalSearchDialog").then((module) => ({ default: module.GlobalSearchDialog })),
);

/** Top-bar search field; ⌘K / Ctrl+K opens it from anywhere. */
export function GlobalSearch(props: GlobalSearchProps) {
  const t = useMessages(shellMessages);
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setUsed(true);
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
        className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg bg-white/10 px-3 text-sm text-white/70 transition-colors hover:bg-white/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <Search className="h-4 w-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left">{t("search")}</span>
        <span className="hidden text-xs text-white/60 sm:inline">⌘K</span>
      </button>
      {used ? (
        <Suspense fallback={null}>
          <GlobalSearchDialog {...props} open={open} setOpen={setOpen} />
        </Suspense>
      ) : null}
    </>
  );
}
