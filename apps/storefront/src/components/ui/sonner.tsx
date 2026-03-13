import { Toaster as SonnerToaster } from "sonner";


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
        success: (
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-primary"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" /><path d="m9 11 3 3L22 4" /></svg>
        ),
      }}
      {...props}
    />
  );
}
