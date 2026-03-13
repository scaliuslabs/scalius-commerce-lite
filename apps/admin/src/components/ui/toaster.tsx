import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { CheckCircle } from "lucide-react";

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => {
        const isSuccess =
          title === "Success" ||
          (typeof title === "string" &&
            title.toLowerCase().includes("success"));

        return (
          <Toast
            key={id}
            {...props}
            className={isSuccess ? "success-toast" : ""}
          >
            <div className="flex items-start gap-3">
              {isSuccess && (
                <div className="shrink-0 mt-0.5">
                  <CheckCircle className="h-5 w-5 text-green-600" />
                </div>
              )}
              <div className="grid gap-1 flex-1">
                {title && <ToastTitle>{title}</ToastTitle>}
                {description && (
                  <ToastDescription>{description}</ToastDescription>
                )}
              </div>
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
