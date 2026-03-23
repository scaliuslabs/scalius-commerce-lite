import { memo, type ReactNode } from "react";
import { Package } from "lucide-react";

export interface EmptyStateConfig {
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  description?: string;
  action?: ReactNode;
}

interface DataTableEmptyStateProps {
  config?: EmptyStateConfig;
}

export const DataTableEmptyState = memo(function DataTableEmptyState({ config }: DataTableEmptyStateProps) {
  const Icon = config?.icon ?? Package;
  const title = config?.title ?? "No results found";
  const description = config?.description ?? "Try adjusting your search or filters.";

  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="h-10 w-10 text-muted-foreground/50 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      <p className="text-xs text-muted-foreground/70 mt-1">{description}</p>
      {config?.action && <div className="mt-4">{config.action}</div>}
    </div>
  );
});
