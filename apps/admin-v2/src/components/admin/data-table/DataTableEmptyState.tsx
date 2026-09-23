import { memo, type ReactNode } from "react";
import { Package } from "lucide-react";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export interface EmptyStateConfig {
  icon?: React.ComponentType<{ className?: string }>;
  title?: string;
  description?: string;
  action?: ReactNode;
}

export const DataTableEmptyState = memo(function DataTableEmptyState({ config }: { config?: EmptyStateConfig }) {
  const t = useMessages(resourceMessages);
  const Icon = config?.icon ?? Package;
  const description = config?.description ?? t("noResultsHint");
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="mb-3 h-8 w-8 text-muted-foreground" />
      <p className="text-body font-semibold">{config?.title ?? t("noResults")}</p>
      {description ? <p className="mt-1 text-body text-muted-foreground">{description}</p> : null}
      {config?.action ? <div className="mt-4">{config.action}</div> : null}
    </div>
  );
});
