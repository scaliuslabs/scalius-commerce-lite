import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useState,
  useRef,
  type ComponentType,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { UnsavedChangesGuard } from "~/components/admin/shared/UnsavedChangesGuard";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTrigger, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { mediaPickerMessages } from "~/i18n/media-picker";
import { chooseKey, type MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPendingUploadsChange?: (count: number) => void;
};

const loadMediaManager = () => import("./MediaManager");

const MediaManagerImpl = lazy(() =>
  loadMediaManager().then((module) => ({
    default: module.MediaManager as ComponentType<MediaManagerInternalProps>,
  })),
);

/**
 * What the dialog shows while its code arrives: the first click on a freshly
 * loaded page is acknowledged at once, never silent.
 */
function MediaManagerLoading({ capability, dialogClassName, onCloseAutoFocus }: Pick<MediaManagerProps, "capability" | "dialogClassName" | "onCloseAutoFocus">) {
  const t = useMessages(mediaPickerMessages);
  return (
    // eslint-disable-next-line shadcn/require-static-classes -- same caller-supplied fullscreen stacking as the loaded picker
    <DialogContent className={dialogClassName} onCloseAutoFocus={onCloseAutoFocus}>
      <DialogTitle>{t(chooseKey(capability ?? "image"))}</DialogTitle>
      <DialogDescription className="sr-only">{t("pickerLoading")}</DialogDescription>
      <p role="status" className="py-6 text-center text-body text-muted-foreground">{t("pickerLoading")}</p>
    </DialogContent>
  );
}

type TriggerElement = ReactElement<{
  "aria-busy"?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  onPointerEnter?: (event: PointerEvent<HTMLElement>) => void;
  onFocus?: (event: FocusEvent<HTMLElement>) => void;
}>;

function MediaManagerTriggerShell({
  trigger,
  triggerLabel,
  capability = "image",
  isLoading = false,
  onOpen,
}: Pick<MediaManagerProps, "trigger" | "triggerLabel" | "capability"> & {
  isLoading?: boolean;
  onOpen: () => void;
}) {
  const t = useMessages(mediaPickerMessages);
  if (isValidElement(trigger)) {
    const triggerElement = trigger as TriggerElement;

    return <DialogTrigger asChild>{cloneElement(triggerElement, {
      "aria-busy": isLoading || undefined,
      disabled: isLoading || triggerElement.props.disabled,
      // The code starts downloading as the pointer or focus arrives, before the click.
      onPointerEnter: (event) => {
        triggerElement.props.onPointerEnter?.(event);
        void loadMediaManager();
      },
      onFocus: (event) => {
        triggerElement.props.onFocus?.(event);
        void loadMediaManager();
      },
      onClick: (event) => {
        triggerElement.props.onClick?.(event);
        if (!event.defaultPrevented) {
          onOpen();
        }
      },
    })}</DialogTrigger>;
  }

  return (
    <DialogTrigger asChild><Button type="button" variant="outline" className="w-full" loading={isLoading} onClick={onOpen}>
      <Upload aria-hidden="true" />
      {triggerLabel ?? t(chooseKey(capability))}
    </Button></DialogTrigger>
  );
}

export function MediaManager(props: MediaManagerProps) {
  const [internalOpen, setOpen] = useState(false);
  const [pendingUploads, setPendingUploads] = useState(0);
  const afterClose = useRef<(() => void) | null>(null);
  const t = useMessages(mediaPickerMessages);
  const controlled = props.open !== undefined;
  const open = props.open ?? internalOpen;
  const onOpenChange = props.onOpenChange;
  const openRef = useRef(open);
  openRef.current = open;

  const handleOpen = useCallback(() => {
    setOpen(true);
  }, []);

  const guard = useDirtyDialogClose({ dirty: pendingUploads > 0, onClose: () => {
    const complete = afterClose.current;
    afterClose.current = null;
    setOpen(false);
    onOpenChange?.(false);
    complete?.();
  } });
  const setAsking = guard.discardDialog.onOpenChange;
  useEffect(() => {
    if (pendingUploads === 0) {
      afterClose.current = null;
      setAsking(false);
    }
  }, [pendingUploads, setAsking]);
  const requestClose = (complete: (() => void) | null = null) => {
    afterClose.current = complete;
    guard.requestClose();
  };
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) requestClose();
    else { setOpen(true); onOpenChange?.(true); }
  };

  if (controlled && !open) return null;

  return (
    <>
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {!controlled && (
        <MediaManagerTriggerShell
          {...props}
          onOpen={handleOpen}
        />
      )}
      {open ? <Suspense fallback={<MediaManagerLoading capability={props.capability} dialogClassName={props.dialogClassName} onCloseAutoFocus={(event) => {
        // Resolving Suspense replaces the loading focus scope while the picker
        // stays open. Only a real close returns focus to the caller.
        if (openRef.current) event.preventDefault();
        else props.onCloseAutoFocus?.(event);
      }} />}>
        <MediaManagerImpl
          {...props}
          open={open}
          onOpenChange={handleOpenChange}
          onPendingUploadsChange={setPendingUploads}
          onSelect={props.onSelect ? (file) => requestClose(() => props.onSelect?.(file)) : undefined}
          onSelectMultiple={props.onSelectMultiple ? (files) => requestClose(() => props.onSelectMultiple?.(files)) : undefined}
        />
      </Suspense> : null}
    </Dialog>
    <ConfirmDialog {...guard.discardDialog}
      onOpenChange={(asking) => { if (!asking) afterClose.current = null; setAsking(asking); }}
      title={t("uploadsInProgress")}
      description={t("uploadsInProgressBody")}
      cancelLabel={t("keepUploading")}
      confirmLabel={t("cancelUploads")}
    />
    {open ? <UnsavedChangesGuard isDirty={pendingUploads > 0} isSubmitting={false} /> : null}
    </>
  );
}
