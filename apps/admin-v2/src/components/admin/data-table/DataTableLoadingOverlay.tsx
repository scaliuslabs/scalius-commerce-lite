import { memo } from "react";

interface DataTableLoadingOverlayProps {
  visible: boolean;
}

export const DataTableLoadingOverlay = memo(function DataTableLoadingOverlay({ visible }: DataTableLoadingOverlayProps) {
  if (!visible) return null;

  return (
    <div className="absolute inset-0 z-10 flex items-start justify-center bg-background/50 pt-20 backdrop-blur-[1px] transition-opacity">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted border-t-primary" />
    </div>
  );
});
