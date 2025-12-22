import { Toaster as SonnerToaster } from "sonner";
import { CheckCircle } from "lucide-react";

interface ToasterProps {
  position?:
    | "top-left"
    | "top-right"
    | "bottom-left"
    | "bottom-right"
    | "top-center"
    | "bottom-center";
  expand?: boolean;
  richColors?: boolean;
  closeButton?: boolean;
  offset?: string | number;
  theme?: "light" | "dark" | "system";
  className?: string;
  duration?: number;
}

export function Toaster({
  position = "top-right",
  expand = false,
  richColors = true,
  closeButton = false,
  theme = "system",
  className = "",
  offset,
  duration,
  ...props
}: ToasterProps) {
  return (
    <SonnerToaster
      position={position}
      expand={expand}
      richColors={richColors}
      closeButton={closeButton}
      theme={theme}
      className={`${className} sonner-toast-container`}
      offset={offset}
      duration={duration}
      icons={{
        success: <CheckCircle className="h-5 w-5 text-green-600" />,
      }}
      {...props}
    />
  );
}
