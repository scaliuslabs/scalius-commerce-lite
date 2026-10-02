// Apps' manifest actions: `bulk: false` ones in a detail page's "More
// actions", `bulk: true` ones on the list's bulk bar. Each POSTs
// `{ resource, ids, action }` to the app's declared route and applies the
// answer: a toast, a refresh of the page's data, a page to open, or a tree
// shown in a dialog. Destructive actions ask first, naming the action.
// Needs apps.use; without it nothing is offered.
import { Suspense, lazy, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "sonner";
import { ChevronDown } from "lucide-react";
import type { PluginUiDocument } from "@scalius/shared/plugins/ui";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import { resourceMessages } from "~/i18n/resource";
import { SurfaceSkeleton } from "./surface-states";
import { useAppActions, type AppAction, type AppSurfaces, type AppTarget } from "./surfaces";

const PluginUiRenderer = lazy(() => import("./PluginUiRenderer").then((module) => ({ default: module.PluginUiRenderer })));

/** Most records one bulk action runs on (`PLUGIN_BULK_ACTION_MAX_IDS` in @scalius/shared/plugins/ui). */
export const APP_BULK_ACTION_MAX_IDS = 250;

export interface AppActionEntry {
  app: AppSurfaces;
  action: AppAction;
}

export const appActionKey = (entry: AppActionEntry) => `${entry.app.id}:${entry.action.id}`;

interface Runner {
  entries: AppActionEntry[];
  /** Runs an action on these records; a destructive one asks first. */
  start: (entry: AppActionEntry, ids: readonly string[], onDone?: () => void) => void;
  /** The action running now, if any (`appActionKey`). */
  pending: string | null;
  /** The confirm and result dialogs: render once, wherever the menu is. */
  dialogs: ReactNode;
}

/**
 * The actions apps offer for a target, and how to run them. Pages with a
 * "More actions" menu of their own add `entries` to it and render `dialogs`;
 * others use `AppActionsMenu` / `AppBulkActionsMenu`.
 */
export function useAppActionRunner(target: AppTarget, bulk: boolean): Runner {
  const t = useMessages(appUiMessages);
  const entries = useAppActions(target, bulk);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [asking, setAsking] = useState<{ entry: AppActionEntry; ids: readonly string[]; onDone?: () => void } | null>(null);
  const [answer, setAnswer] = useState<{ entry: AppActionEntry; ids: readonly string[]; document: PluginUiDocument } | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);

  const run = async (entry: AppActionEntry, ids: readonly string[], onDone?: () => void) => {
    if (ids.length === 0) return;
    if (ids.length > APP_BULK_ACTION_MAX_IDS) {
      toast.error(t("tooManySelected", { max: APP_BULK_ACTION_MAX_IDS }));
      return;
    }
    const key = appActionKey(entry);
    setPending(key);
    try {
      let actions: typeof import("./run-action");
      try {
        actions = await import("./run-action");
      } catch {
        // The dashboard was updated meanwhile (its old code is gone): nothing was sent.
        toast.error(t("actionFailed"));
        return;
      }
      const { runAppRoute, hasActionEffect, showActionToast, openTarget, appErrorMessage } = actions;
      let outcome;
      try {
        outcome = await runAppRoute(entry.app, { route: entry.action.route, method: "POST" }, {
          resource: target,
          ids: [...ids],
          action: entry.action.id,
        });
      } catch (error) {
        toast.error(appErrorMessage(error));
        return;
      }
      const { ok, result } = outcome;
      if (!ok && !hasActionEffect(result)) {
        toast.error(t("actionFailed"));
        return;
      }
      showActionToast(result, ok);
      if (result.errors && !result.toast) toast.error(Object.values(result.errors).join(" "));
      if (ok && !hasActionEffect(result)) toast.success(t("actionSent"));
      if (result.ui) {
        setAnswer({ entry, ids, document: result.ui as PluginUiDocument });
        setAnswerOpen(true);
      }
      // The records changed: every query on screen reads them again (app cards included).
      if (result.refresh) void queryClient.invalidateQueries({ refetchType: "active" });
      if (result.navigate) openTarget(navigate as (options: { to: string; search?: Record<string, string> }) => unknown, entry.app, result.navigate);
      if (ok) onDone?.();
    } finally {
      setPending(null);
    }
  };

  const start: Runner["start"] = (entry, ids, onDone) => {
    if (entry.action.destructive) setAsking({ entry, ids, onDone });
    else void run(entry, ids, onDone);
  };

  const dialogs = (
    <>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => (open ? undefined : setAsking(null))}
        title={asking ? t("confirmTitle", { action: asking.entry.action.label }) : ""}
        description={asking
          ? asking.ids.length > 1
            ? t("confirmMany", { app: asking.entry.app.name, count: asking.ids.length })
            : t("confirmOne", { app: asking.entry.app.name })
          : ""}
        confirmLabel={asking?.entry.action.label}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          if (asking) void run(asking.entry, asking.ids, asking.onDone);
          setAsking(null);
        }}
      />
      <Dialog open={answerOpen} onOpenChange={setAnswerOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{answer?.entry.action.label ?? ""}</DialogTitle>
            <DialogDescription>{answer ? t("fromApp", { app: answer.entry.app.name }) : ""}</DialogDescription>
          </DialogHeader>
          {answer ? (
            <Suspense fallback={<SurfaceSkeleton variant="embedded" />}>
              <PluginUiRenderer
                document={answer.document}
                variant="embedded"
                host={{
                  app: answer.entry.app,
                  resource: answer.ids.length === 1 ? { target, id: answer.ids[0]! } : null,
                  replace: (next) => setAnswer((current) => (current ? { ...current, document: next } : current)),
                  refresh: () => void queryClient.invalidateQueries({ refetchType: "active" }),
                  paginate: null,
                }}
              />
            </Suspense>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setAnswerOpen(false)}>{t("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  return { entries, start, pending, dialogs };
}

/** A "More actions" menu of apps' actions for one record; nothing when no app offers one. */
export function AppActionsMenu({ target, id, size }: { target: AppTarget; id: string; size?: "sm" }) {
  const r = useMessages(resourceMessages);
  const runner = useAppActionRunner(target, false);
  if (runner.entries.length === 0) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size={size} loading={runner.pending !== null}>
            {r("moreActions")}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {runner.entries.map((entry) => (
            <DropdownMenuItem
              key={appActionKey(entry)}
              variant={entry.action.destructive ? "destructive" : undefined}
              onSelect={() => runner.start(entry, [id])}
            >
              {entry.action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {runner.dialogs}
    </>
  );
}

/** Apps' bulk actions for the selected rows (at most 250); `onDone` clears the selection after one succeeds. */
export function AppBulkActionsMenu({ target, ids, onDone }: { target: AppTarget; ids: readonly string[]; onDone?: () => void }) {
  const t = useMessages(appUiMessages);
  const runner = useAppActionRunner(target, true);
  if (runner.entries.length === 0) return null;
  const tooMany = ids.length > APP_BULK_ACTION_MAX_IDS;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline" size="sm" loading={runner.pending !== null} disabled={ids.length === 0}>
            {t("appActions")}
            <ChevronDown aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {runner.entries.map((entry) => (
            <DropdownMenuItem
              key={appActionKey(entry)}
              disabled={tooMany}
              variant={entry.action.destructive ? "destructive" : undefined}
              onSelect={() => runner.start(entry, ids, onDone)}
            >
              {tooMany ? (
                <span className="flex max-w-64 flex-col">
                  <span>{entry.action.label}</span>
                  <span className="text-muted-foreground">{t("tooManySelected", { max: APP_BULK_ACTION_MAX_IDS })}</span>
                </span>
              ) : entry.action.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {runner.dialogs}
    </>
  );
}
