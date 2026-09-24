import {
  cloneElement,
  isValidElement,
  lazy,
  Suspense,
  useCallback,
  useState,
  type ComponentType,
  type MouseEvent,
  type ReactElement,
} from "react";
import { Upload } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogTrigger } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { mediaMessages } from "~/i18n/media";
import { chooseKey, type MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const MediaManagerImpl = lazy(() =>
  import("./MediaManager").then((module) => ({
    default: module.MediaManager as ComponentType<MediaManagerInternalProps>,
  })),
);

type TriggerElement = ReactElement<{
  "aria-busy"?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
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
  const t = useMessages(mediaMessages);
  if (isValidElement(trigger)) {
    const triggerElement = trigger as TriggerElement;

    return cloneElement(triggerElement, {
      "aria-busy": isLoading || undefined,
      disabled: isLoading || triggerElement.props.disabled,
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
      <Suspense fallback={null}>
        <MediaManagerImpl
          {...props}
          open={open}
          onOpenChange={handleOpenChange}
        />
      </Suspense>
    </Dialog>
  );
}
