import { lazy, Suspense, useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useMessages } from "~/i18n";
import { shellMessages } from "~/i18n/shell";
import { GO_SHORTCUTS } from "./AdminNav";
import type { GlobalSearchProps } from "./GlobalSearchDialog";

// cmdk loads in its own chunk after the shell; the dialog itself stays mounted.
const GlobalSearchDialog = lazy(() =>
  import("./GlobalSearchDialog").then((module) => ({ default: module.GlobalSearchDialog })),
);

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const SEQUENCE_MS = 1000;

function typingIn(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']"));
}

/**
 * Top-bar search. ⌘K / Ctrl+K or S opens it; G then H, O, P, C, D or S jumps
 * to a section (Shopify's sequences). Shortcuts never fire while typing.
 */
export function GlobalSearch(props: GlobalSearchProps) {
  const { canOpen } = props;
  const t = useMessages(shellMessages);
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let goPressedAt = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || typingIn(event.target)) return;
      if (Date.now() - goPressedAt < SEQUENCE_MS && GO_SHORTCUTS[key]) {
        goPressedAt = 0;
        const to = GO_SHORTCUTS[key]!;
        if (canOpen(to)) {
          event.preventDefault();
          void navigate({ to });
        }
        return;
      }
      if (key === "g") goPressedAt = Date.now();
      else if (key === "s") {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canOpen, navigate]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-keyshortcuts={isMac ? "Meta+K S" : "Control+K S"}
        data-topbar-search=""
        className="flex h-9 w-full max-w-160 items-center gap-2 rounded-xl bg-topbar-subdued pl-3 pr-2 text-body text-topbar-foreground outline-none hover:bg-topbar-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="flex-1 truncate text-left">{t("search")}</span>
        <span className="hidden items-center gap-1 sm:flex" aria-hidden>
          <kbd className="flex h-5 min-w-5 items-center justify-center rounded-md bg-topbar-hover px-1 text-caption text-topbar-foreground">{isMac ? "⌘" : "Ctrl"}</kbd>
          <kbd className="flex h-5 min-w-5 items-center justify-center rounded-md bg-topbar-hover px-1 text-caption text-topbar-foreground">K</kbd>
        </span>
      </button>
      <Suspense fallback={null}>
        <GlobalSearchDialog {...props} open={open} setOpen={setOpen} />
      </Suspense>
    </>
  );
}
