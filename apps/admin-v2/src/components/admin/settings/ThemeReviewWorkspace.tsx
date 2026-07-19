import { useEffect, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  History,
  Loader2,
  Maximize2,
  Monitor,
  MonitorSmartphone,
  RotateCcw,
  Smartphone,
} from "lucide-react";

import type { ThemeVersionPayload } from "~/lib/api-functions/settings";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  normalizeThemePreviewPath,
  type StorefrontReviewLink,
  type ThemeDraftChange,
  type ThemePreviewDevice,
} from "./theme-workspace";

const DEVICE_OPTIONS: Array<{
  value: ThemePreviewDevice;
  label: string;
  icon: typeof Monitor;
}> = [
  { value: "full", label: "Full", icon: Maximize2 },
  { value: "desktop", label: "Desktop", icon: Monitor },
  { value: "mobile", label: "Mobile", icon: Smartphone },
];

export function ThemeReviewWorkspace({
  draftChanges,
  publishedRevision,
  draftRevision,
  dirty,
  hasUnpublishedChanges,
  publishBlocked,
  storefrontLinks,
  storefrontUrlUnavailable,
  previewPath,
  previewDevice,
  onPreviewLocationChange,
  onPreview,
  previewing,
  versions,
  historyLoading,
  historyError,
  canManage,
  restoringRevision,
  onRestore,
}: {
  draftChanges: ThemeDraftChange[];
  publishedRevision: number;
  draftRevision: number;
  dirty: boolean;
  hasUnpublishedChanges: boolean;
  publishBlocked: boolean;
  storefrontLinks: StorefrontReviewLink[];
  storefrontUrlUnavailable: boolean;
  previewPath: string;
  previewDevice: ThemePreviewDevice;
  onPreviewLocationChange: (path: string, device: ThemePreviewDevice) => void;
  onPreview: (path: string, device: ThemePreviewDevice) => void;
  previewing: boolean;
  versions: ThemeVersionPayload[];
  historyLoading: boolean;
  historyError: string | null;
  canManage: boolean;
  restoringRevision: number | null;
  onRestore: (sourceRevision: number) => void;
}) {
  const [pathInput, setPathInput] = useState(previewPath);
  const [pathError, setPathError] = useState<string | null>(null);
  const [restoreCandidate, setRestoreCandidate] = useState<number | null>(null);

  useEffect(() => setPathInput(previewPath), [previewPath]);

  const commitPreviewPath = () => {
    const normalized = normalizeThemePreviewPath(pathInput);
    if (pathInput.trim() !== normalized) {
      setPathError("Use a public home, search, product, category, collection, or page path.");
      return;
    }
    setPathError(null);
    onPreviewLocationChange(normalized, previewDevice);
  };

  const openPreview = () => {
    const normalized = normalizeThemePreviewPath(pathInput);
    if (pathInput.trim() !== normalized) {
      setPathError("Use a public home, search, product, category, collection, or page path.");
      return;
    }
    setPathError(null);
    onPreviewLocationChange(normalized, previewDevice);
    onPreview(normalized, previewDevice);
  };

  const candidate = restoreCandidate === null
    ? null
    : versions.find((version) => version.revision === restoreCandidate) ?? null;

  return (
    <>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Draft changes</h2>
                <p className="text-xs text-muted-foreground">
                  Draft r{draftRevision || "new"} compared with published r{publishedRevision || "—"}.
                </p>
              </div>
              <span className="shrink-0 rounded-full border px-2 py-1 text-xs text-muted-foreground">
                {draftChanges.length} {draftChanges.length === 1 ? "change" : "changes"}
              </span>
            </div>
            {draftChanges.length === 0 ? (
              <div className="flex min-h-32 items-center justify-center p-6 text-center">
                <div className="max-w-sm">
                  <CheckCircle2 className="mx-auto h-5 w-5 text-emerald-600" />
                  <p className="mt-2 text-sm font-medium">Published style is current</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Change the design system or colors to prepare another revision.
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

          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-4 py-3">
              <MonitorSmartphone className="h-4 w-4" />
              <div>
                <h2 className="text-sm font-semibold">Storefront preview</h2>
                <p className="text-xs text-muted-foreground">Open this exact draft on a real public route.</p>
              </div>
            </div>
            <div className="grid gap-3 p-3 md:grid-cols-[minmax(0,1fr)_auto_auto] md:items-end">
              <label className="min-w-0">
                <span className="mb-1 block text-xs font-medium">Public path</span>
                <input
                  value={pathInput}
                  onChange={(event) => {
                    setPathInput(event.target.value);
                    setPathError(null);
                  }}
                  onBlur={commitPreviewPath}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitPreviewPath();
                    }
                  }}
                  aria-invalid={Boolean(pathError)}
                  aria-describedby={pathError ? "theme-preview-path-error" : undefined}
                  placeholder="/products/product-slug"
                  className="min-h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>
              <div>
                <span className="mb-1 block text-xs font-medium">Viewport</span>
                <div className="flex rounded-md border bg-background p-0.5" role="group" aria-label="Preview viewport">
                  {DEVICE_OPTIONS.map((option) => {
                    const Icon = option.icon;
                    const active = previewDevice === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        aria-pressed={active}
                        aria-label={option.label}
                        title={option.label}
                        onClick={() => onPreviewLocationChange(previewPath, option.value)}
                        className={`inline-flex min-h-9 min-w-10 items-center justify-center rounded px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          active ? "bg-foreground text-background" : "text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        <Icon className="h-4 w-4" />
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                onClick={openPreview}
                disabled={previewing || publishBlocked || storefrontLinks.length === 0 || (!canManage && draftRevision === 0)}
                className="inline-flex min-h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
              >
                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <ExternalLink className="h-4 w-4" />}
                {previewing ? "Opening…" : "Preview draft"}
              </button>
            </div>
            {pathError && (
              <p id="theme-preview-path-error" className="px-3 pb-3 text-xs text-destructive">
                {pathError}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 text-xs text-muted-foreground">
              <span>{dirty ? "Current changes are saved before preview opens." : "Preview uses the saved draft snapshot."}</span>
              {storefrontLinks.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  Published {link.label.toLowerCase()}
                  <span className="sr-only"> opens in a new tab</span>
                </a>
              ))}
              {storefrontLinks.length === 0 && (
                <a
                  href="/admin/settings?section=storefront"
                  className="font-medium text-foreground underline-offset-4 hover:underline"
                >
                  {storefrontUrlUnavailable ? "Check Storefront URL" : "Configure Storefront URL"}
                </a>
              )}
            </div>
          </section>
        </div>

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
                  ? "Save or preview to preserve this tab's changes."
                  : hasUnpublishedChanges
                    ? `Publishing creates revision ${publishedRevision + 1}.`
                    : "There are no unpublished changes."}
            </p>
          </section>

          <section className="overflow-hidden rounded-xl border bg-card">
            <div className="flex items-center gap-2 border-b px-3 py-2.5">
              <History className="h-4 w-4" />
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Published history</h2>
                <p className="text-xs text-muted-foreground">Restores become new revisions.</p>
              </div>
            </div>
            <div className="max-h-[28rem] overflow-y-auto">
              {historyLoading && (
                <div className="space-y-2 p-3" aria-busy="true">
                  <div className="h-12 animate-pulse rounded-md bg-muted" />
                  <div className="h-12 animate-pulse rounded-md bg-muted" />
                </div>
              )}
              {!historyLoading && historyError && (
                <p role="alert" className="p-3 text-xs text-destructive">{historyError}</p>
              )}
              {!historyLoading && !historyError && versions.length === 0 && (
                <p className="p-3 text-xs text-muted-foreground">No published revisions yet.</p>
              )}
              {!historyLoading && !historyError && versions.map((version) => {
                const current = version.revision === publishedRevision;
                const restoring = restoringRevision === version.revision;
                return (
                  <div key={version.id} className="flex items-center justify-between gap-3 border-b px-3 py-2.5 last:border-b-0">
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium">Revision {version.revision}</span>
                        {current && <span className="rounded-full bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">Current</span>}
                      </div>
                      <p className="truncate text-[11px] text-muted-foreground">
                        {describeVersion(version)} · {formatVersionDate(version.createdAt)}
                      </p>
                    </div>
                    {!current && (
                      <button
                        type="button"
                        onClick={() => setRestoreCandidate(version.revision)}
                        disabled={!canManage || restoringRevision !== null}
                        className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                      >
                        {restoring ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        Restore
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      <AlertDialog
        open={restoreCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreCandidate(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore revision {candidate?.revision}?</AlertDialogTitle>
            <AlertDialogDescription>
              This publishes its exact style as revision {publishedRevision + 1} and replaces the current draft. Existing history remains unchanged.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current style</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (candidate) onRestore(candidate.revision);
                setRestoreCandidate(null);
              }}
            >
              Restore as new revision
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function describeVersion(version: ThemeVersionPayload): string {
  if (version.source === "rollback" && version.sourceRevision) {
    return `Restored from r${version.sourceRevision}`;
  }
  if (version.source === "migration") return "Imported baseline";
  return "Published";
}

function formatVersionDate(value: string | number): string {
  const numeric = typeof value === "number" && value < 10_000_000_000
    ? value * 1000
    : value;
  const date = new Date(numeric);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
