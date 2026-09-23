import { useRef } from "react";
import { createFileRoute, Outlet, useRouter } from "@tanstack/react-router";
import { X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { SaveBarProvider } from "~/components/admin/shared/SaveBar";
import { SettingsNav } from "~/components/admin/settings/SettingsNav";
import { useMessages } from "~/i18n";
import { settingsMessages } from "~/i18n/settings";

// Shopify's full-screen settings: one persistent panel with its own settings
// list; moving between pages swaps only the Outlet, and one contextual save
// bar serves every page.
export const Route = createFileRoute("/admin/settings")({
  component: SettingsLayout,
});

function historyIndex(state: unknown): number {
  const index = (state as { __TSR_index?: unknown } | null)?.__TSR_index;
  return typeof index === "number" ? index : 0;
}

function SettingsLayout() {
  const router = useRouter();
  const t = useMessages(settingsMessages);
  // Where the merchant entered settings, so ✕ returns to the page before it.
  const entryIndex = useRef(historyIndex(router.history.location.state));

  function close() {
    if (entryIndex.current > 0) {
      router.history.go(entryIndex.current - 1 - historyIndex(router.history.location.state));
    } else {
      void router.navigate({ to: "/admin" });
    }
  }

  return (
    <SaveBarProvider>
      {/* A panel on desktop; full width on phones so cards aren't nested. */}
      <div className="relative mx-auto max-w-6xl lg:flex lg:rounded-xl lg:border lg:border-border lg:bg-background">
        <aside className="hidden w-60 shrink-0 border-r border-border bg-card p-3 lg:block lg:rounded-l-xl">
          {/* eslint-disable-next-line no-restricted-syntax -- the whole settings column sticks; it is not a bar over content */}
          <div className="sticky top-3">
            <SettingsNav variant="sidebar" />
          </div>
        </aside>
        <div className="min-w-0 flex-1 pb-6 lg:px-6 lg:pt-6">
          <Outlet />
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("close")}
          className="absolute right-0 top-0 lg:right-2 lg:top-2"
          onClick={close}
        >
          <X className="size-5" aria-hidden="true" />
        </Button>
      </div>
    </SaveBarProvider>
  );
}
