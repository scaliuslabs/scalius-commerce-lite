import { Toaster as Sonner, type ToasterProps } from "sonner";
import {
  CircleCheck,
  CircleX,
  Info,
  Loader2,
  TriangleAlert,
} from "lucide-react";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      richColors
      closeButton
      expand={false}
      visibleToasts={4}
      gap={12}
      offset={16}
      duration={4000}
      toastOptions={{
        classNames: {
          toast:
            "!border !shadow-lg !rounded-lg !font-sans !text-[13px] !leading-snug !px-4 !py-3",
          title: "!font-medium !text-[13px]",
          description: "!text-[12px] !opacity-80",
          actionButton:
            "!bg-primary !text-primary-foreground !text-xs !font-medium !rounded-md !px-3 !h-7",
          cancelButton:
            "!bg-muted !text-muted-foreground !text-xs !font-medium !rounded-md !px-3 !h-7",
          closeButton: "!transition-all",
        },
      }}
      icons={{
        success: <CircleCheck className="h-[18px] w-[18px]" />,
        error: <CircleX className="h-[18px] w-[18px]" />,
        info: <Info className="h-[18px] w-[18px]" />,
        warning: <TriangleAlert className="h-[18px] w-[18px]" />,
        loading: <Loader2 className="h-[18px] w-[18px] animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}

export { Toaster };
