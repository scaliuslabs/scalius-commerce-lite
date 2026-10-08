// Apps' manifest actions: `bulk: false` ones in a detail page's "More
// actions", `bulk: true` ones on the list's bulk bar. Each POSTs
// `{ resource, ids, action }` to the app's declared route and applies the
// answer: a toast, a refresh of the page's data, a page to open, or a tree
// shown in a dialog. Destructive actions ask first, naming the action.
// Needs apps.use; without it nothing is offered. Light on purpose: list and
// detail pages carry it, so sending (run-action) and the dialogs load on use.
import { Suspense, lazy, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { toast } from "~/lib/toast";
import { ChevronDown } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useMessages } from "~/i18n";
import { appActionMessages } from "~/i18n/app-actions";
import { resourceMessages } from "~/i18n/resource";
import type { AppActionAnswer, AppActionRequest } from "./AppActionDialogs";
import type { Navigate } from "./run-action";
import { useAppActions, type AppAction, type AppSurfaces, type AppTarget } from "./surfaces";

const AppActionDialogs = lazy(() => import("./AppActionDialogs").then((module) => ({ default: module.AppActionDialogs })));

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
  const t = useMessages(appActionMessages);
  const r = useMessages(resourceMessages);
  const entries = useAppActions(target, bulk);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [pending, setPending] = useState<string | null>(null);
  const [asking, setAsking] = useState<AppActionRequest | null>(null);
  const [answer, setAnswer] = useState<AppActionAnswer | null>(null);
  const [answerOpen, setAnswerOpen] = useState(false);
  // Loaded the first time an action asks first or answers with a tree.
  const dialogsLoaded = useOpenedOnce(asking !== null || answerOpen);
  const refresh = () => void queryClient.invalidateQueries({ refetchType: "active" });

  const run = async ({ entry, ids, onDone }: AppActionRequest) => {
    if (ids.length === 0) return;
    if (ids.length > APP_BULK_ACTION_MAX_IDS) {
      toast.error(t("tooManySelected", { max: APP_BULK_ACTION_MAX_IDS }));
      return;
    }
    setPending(appActionKey(entry));
    try {
      let actions: typeof import("./run-action");
      try {
        actions = await import("./run-action");
      } catch {
        // The dashboard was updated meanwhile (its old code is gone): nothing was sent.
        toast.error(r("actionFailed"));
        return;
      }
      const ok = await actions.runManifestAction(entry, target, ids, {
        refresh,
        navigate: navigate as Navigate,
        showAnswer: (document) => {
          setAnswer({ entry, ids, document });
          setAnswerOpen(true);
        },
      });
      if (ok) onDone?.();
    } finally {
      setPending(null);
    }
  };

  const start: Runner["start"] = (entry, ids, onDone) => {
    if (!entry.action.destructive) {
      void run({ entry, ids, onDone });
      return;
    }
    setAsking({ entry, ids, onDone });
  };

  const dialogs = dialogsLoaded ? (
    <Suspense fallback={null}>
      <AppActionDialogs
        target={target}
        asking={asking}
        onCancel={() => setAsking(null)}
        onConfirm={(request) => {
          void run(request);
          setAsking(null);
        }}
        answer={answer}
        answerOpen={answerOpen}
        onAnswerOpenChange={setAnswerOpen}
        onAnswerReplace={(document) => setAnswer((current) => (current ? { ...current, document } : current))}
        onRefresh={refresh}
      />
    </Suspense>
  ) : null;

  return { entries, start, pending, dialogs };
}

/**
 * A "More actions" menu of apps' actions for one record, after the page's own
 * `extraItems` (menu items); nothing when neither exists.
 */
export function AppActionsMenu({ target, id, size, extraItems }: { target: AppTarget; id: string; size?: "sm"; extraItems?: ReactNode }) {
  const r = useMessages(resourceMessages);
  const runner = useAppActionRunner(target, false);
  if (runner.entries.length === 0 && !extraItems) return null;
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
          {extraItems}
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
  const t = useMessages(appActionMessages);
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
