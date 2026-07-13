import {
  CheckCircle2,
  ExternalLink,
  History,
  MonitorSmartphone,
} from "lucide-react";

import type {
  StorefrontReviewLink,
  ThemeDraftChange,
} from "./theme-workspace";

export function ThemeReviewWorkspace({
  draftChanges,
  revision,
  dirty,
  publishBlocked,
  storefrontLinks,
  storefrontUrlUnavailable,
}: {
  draftChanges: ThemeDraftChange[];
  revision: number;
  dirty: boolean;
  publishBlocked: boolean;
  storefrontLinks: StorefrontReviewLink[];
  storefrontUrlUnavailable: boolean;
}) {
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">Draft ledger</h2>
            <p className="text-xs text-muted-foreground">
              Compare this tab with published revision {revision} before publishing.
            </p>
          </div>
          <span className="shrink-0 rounded-full border px-2 py-1 text-xs text-muted-foreground">
            {draftChanges.length} {draftChanges.length === 1 ? "change" : "changes"}
          </span>
        </div>
        {draftChanges.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <CheckCircle2 className="mx-auto h-5 w-5 text-emerald-600" />
              <p className="mt-2 text-sm font-medium">Published style is current</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Change the design system or colors to build the next revision.
              </p>
            </div>
          </div>
        ) : (
          <div className="divide-y">
            {draftChanges.map((change) => (
              <div
                key={change.key}
                className="grid gap-1 px-4 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_1.25rem_minmax(0,1fr)] sm:items-center"
              >
                <span className="font-medium">{change.label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {change.published}
                </span>
                <span className="hidden text-center text-muted-foreground sm:block">→</span>
                <span className="truncate text-xs font-medium sm:text-sm">
                  {change.draft}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <aside className="space-y-4 lg:sticky lg:top-20">
        <section className="rounded-xl border bg-card p-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Publish readiness</h2>
            <span className={`text-xs font-medium ${
              publishBlocked
                ? "text-destructive"
                : "text-emerald-700 dark:text-emerald-300"
            }`}>
              {publishBlocked ? "Blocked" : "Ready"}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
            {publishBlocked
              ? "Resolve invalid color values or contrast failures in Colors."
              : dirty
                ? `Publishing creates revision ${revision + 1} and updates buyer-facing theme tokens.`
                : "There are no unpublished changes in this tab."}
          </p>
        </section>

        <section className="overflow-hidden rounded-xl border bg-card">
          <div className="flex items-center gap-2 border-b px-3 py-2.5">
            <MonitorSmartphone className="h-4 w-4" />
            <h2 className="text-sm font-semibold">Review published routes</h2>
          </div>
          <div className="space-y-2 p-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              These open the real storefront in a new tab. They show the published revision, not this unpublished draft.
            </p>
            {storefrontLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-h-11 items-center justify-between gap-3 rounded-md border bg-background px-3 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="min-w-0">
                  <span className="block font-medium">{link.label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {link.description}
                  </span>
                  <span className="sr-only">Opens in a new tab</span>
                </span>
                <ExternalLink className="h-4 w-4 shrink-0 text-muted-foreground" />
              </a>
            ))}
            {storefrontLinks.length === 0 && (
              <div className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
                <p>
                  {storefrontUrlUnavailable
                    ? "Storefront URL could not be checked. Theme editing remains available."
                    : "A valid absolute storefront URL is required for live route review."}
                </p>
                <a
                  href="/admin/settings?section=storefront"
                  className="mt-2 inline-flex min-h-9 items-center font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Configure storefront URL
                </a>
              </div>
            )}
          </div>
        </section>

        <section className="space-y-2 rounded-xl border bg-card p-3 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <History className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Revision {revision} is current. Durable history and rollback still require a separate authority.
            </p>
          </div>
          <div className="flex gap-2">
            <MonitorSmartphone className="mt-0.5 h-4 w-4 shrink-0" />
            <p>Draft route/device preview is not available; this workspace does not simulate one.</p>
          </div>
        </section>
      </aside>
    </div>
  );
}
