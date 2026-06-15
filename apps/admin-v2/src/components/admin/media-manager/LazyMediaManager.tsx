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
import type { MediaManagerProps } from "./types";

type MediaManagerInternalProps = MediaManagerProps & {
  initialOpen?: boolean;
  onInitialOpenHandled?: () => void;
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
  triggerLabel = "Select Image",
  isLoading = false,
  onOpen,
}: Pick<MediaManagerProps, "trigger" | "triggerLabel"> & {
  isLoading?: boolean;
  onOpen: () => void;
}) {
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
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={isLoading}
      aria-busy={isLoading || undefined}
      onClick={onOpen}
    >
      <Upload className="mr-2 h-4 w-4" />
      {isLoading ? "Loading media..." : triggerLabel}
    </Button>
  );
}

export function MediaManager(props: MediaManagerProps) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const [openOnLoad, setOpenOnLoad] = useState(false);

  const handleOpen = useCallback(() => {
    setShouldLoad(true);
    setOpenOnLoad(true);
  }, []);

  const handleInitialOpen = useCallback(() => {
    setOpenOnLoad(false);
  }, []);

  if (!shouldLoad) {
    return <MediaManagerTriggerShell {...props} onOpen={handleOpen} />;
  }

  return (
    <Suspense
      fallback={
        <MediaManagerTriggerShell {...props} isLoading onOpen={handleOpen} />
      }
    >
      <MediaManagerImpl
        {...props}
        initialOpen={openOnLoad}
        onInitialOpenHandled={handleInitialOpen}
      />
    </Suspense>
  );
}
