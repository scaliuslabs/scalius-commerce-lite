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
      {/* On desktop a panel the height of the window, as in Shopify: its top
          edge and ✕ never scroll away; the list and the page scroll inside it.
          On phones it is the page itself and the ✕ sticks to the top. */}
      <div className="relative mx-auto max-w-6xl lg:flex lg:h-[calc(100svh-5.5rem)] lg:overflow-clip lg:rounded-xl lg:border lg:border-border lg:bg-background">
        {/* eslint-disable-next-line no-restricted-syntax -- a pinned button, not a bar over content */}
        <div className="pointer-events-none sticky top-2 z-10 flex h-0 justify-end lg:absolute lg:right-3 lg:top-3 lg:h-auto">
          <Button
            type="button"
            variant="secondary"
            size="icon"
            aria-label={t("close")}
            title={t("close")}
            className="pointer-events-auto"
            onClick={close}
          >
            <X className="size-5" aria-hidden="true" />
          </Button>
        </div>
        <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-card p-3 lg:block">
          <SettingsNav variant="sidebar" />
        </aside>
        <div
          data-settings-scroll=""
          data-scroll-restoration-id="settings-scroll"
          className="min-w-0 flex-1 pb-6 lg:overflow-y-auto lg:px-6 lg:pt-6 lg:[scrollbar-gutter:stable]"
        >
          <Outlet />
        </div>
      </div>
    </SaveBarProvider>
  );
}
