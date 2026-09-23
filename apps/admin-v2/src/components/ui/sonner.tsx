import { Toaster as Sonner, type ToasterProps } from "sonner";
import { CircleAlert, CircleCheck, Info, Loader2, TriangleAlert, X } from "lucide-react";

/** Polaris toast: a short near-black message at the bottom; errors are critical red. */
const inverse = "bg-topbar text-topbar-foreground";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-center"
      closeButton
      visibleToasts={3}
      gap={8}
      offset={16}
      duration={4000}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "flex w-full items-center gap-2.5 rounded-xl py-3 pl-4 pr-2 text-body font-medium shadow-popover",
          default: inverse,
          success: inverse,
          info: inverse,
          warning: inverse,
          loading: inverse,
          error: "bg-destructive text-destructive-foreground",
          content: "min-w-0 flex-1",
          description: "font-normal opacity-80",
          icon: "flex shrink-0 [&_svg]:size-4",
          actionButton: "shrink-0 rounded-lg px-2 py-1 underline underline-offset-2 hover:no-underline",
          cancelButton: "shrink-0 rounded-lg px-2 py-1 opacity-80 hover:opacity-100",
          closeButton:
            "order-last ml-auto flex size-7 shrink-0 items-center justify-center rounded-lg opacity-80 hover:opacity-100",
        },
      }}
      icons={{
        success: <CircleCheck />,
        error: <CircleAlert />,
        info: <Info />,
        warning: <TriangleAlert />,
        loading: <Loader2 className="animate-spin" />,
        close: <X className="size-4" />,
      }}
      {...props}
    />
  );
}

export { Toaster };
