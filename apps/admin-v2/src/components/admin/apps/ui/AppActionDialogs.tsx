// The dialogs of apps' manifest actions: the confirm a destructive action
// asks first, and the tree an app answers with. Loaded the first time either
// opens (useAppActionRunner), then kept mounted so they animate closed.
import { Suspense, lazy } from "react";
import type { PluginUiDocument } from "@scalius/shared/plugins/ui";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { appUiMessages } from "~/i18n/app-ui";
import type { AppActionEntry } from "./AppActions";
import { SurfaceSkeleton } from "./surface-states";
import type { AppTarget } from "./surfaces";

const PluginUiRenderer = lazy(() => import("./PluginUiRenderer").then((module) => ({ default: module.PluginUiRenderer })));

export interface AppActionRequest {
  entry: AppActionEntry;
  ids: readonly string[];
  onDone?: () => void;
}

export interface AppActionAnswer {
  entry: AppActionEntry;
  ids: readonly string[];
  document: PluginUiDocument;
}

export function AppActionDialogs({ target, asking, onCancel, onConfirm, answer, answerOpen, onAnswerOpenChange, onAnswerReplace, onRefresh }: {
  target: AppTarget;
  asking: AppActionRequest | null;
  onCancel: () => void;
  onConfirm: (request: AppActionRequest) => void;
  answer: AppActionAnswer | null;
  answerOpen: boolean;
  onAnswerOpenChange: (open: boolean) => void;
  onAnswerReplace: (document: PluginUiDocument) => void;
  onRefresh: () => void;
}) {
  const t = useMessages(appUiMessages);
  return (
    <>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => (open ? undefined : onCancel())}
        title={asking ? t("confirmTitle", { action: asking.entry.action.label }) : ""}
        description={asking
          ? asking.ids.length > 1
            ? t("confirmMany", { app: asking.entry.app.name, count: asking.ids.length })
            : t("confirmOne", { app: asking.entry.app.name })
          : ""}
        confirmLabel={asking?.entry.action.label}
        cancelLabel={t("cancel")}
        onConfirm={() => {
          if (asking) onConfirm(asking);
        }}
      />
      <Dialog open={answerOpen} onOpenChange={onAnswerOpenChange}>
        <DialogContent className="sm:max-w-160">
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
                  replace: onAnswerReplace,
                  refresh: onRefresh,
                  paginate: null,
                }}
              />
            </Suspense>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onAnswerOpenChange(false)}>{t("close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
