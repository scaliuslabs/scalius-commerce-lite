import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
} from "react";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTrigger, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { mediaPickerMessages } from "~/i18n/media-picker";
import { chooseKey, type MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
function MediaManagerLoading({ capability }: { capability: MediaManagerProps["capability"] }) {
  const t = useMessages(mediaPickerMessages);
  return (
    <DialogContent>
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

    return cloneElement(triggerElement, {
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
    });
  }

  return (
    <Button type="button" variant="outline" className="w-full" loading={isLoading} onClick={onOpen}>
      <Upload aria-hidden="true" />
      {triggerLabel ?? t(chooseKey(capability))}
    </Button>
  );
}

export function MediaManager(props: MediaManagerProps) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const [open, setOpen] = useState(false);

  const handleOpen = useCallback(() => {
    setShouldLoad(true);
    setOpen(true);
  }, []);

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setShouldLoad(false);
  }, []);

  if (!shouldLoad) {
    return <MediaManagerTriggerShell {...props} onOpen={handleOpen} />;
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <MediaManagerTriggerShell
          {...props}
          onOpen={() => setShouldLoad(true)}
        />
      </DialogTrigger>
      <Suspense fallback={<MediaManagerLoading capability={props.capability} />}>
        <MediaManagerImpl
          {...props}
          open={open}
          onOpenChange={handleOpenChange}
        />
      </Suspense>
    </Dialog>
  );
}
