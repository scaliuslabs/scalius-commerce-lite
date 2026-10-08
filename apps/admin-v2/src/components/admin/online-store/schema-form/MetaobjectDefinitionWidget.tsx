import { lazy, Suspense } from "react";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import type { SettingWidgetProps } from "./SchemaSettingsForm";

// The picker and its copy load when a Content types section is first edited.
const MetaobjectDefinitionField = lazy(() =>
  import("./MetaobjectDefinitionField").then((module) => ({ default: module.MetaobjectDefinitionField })),
);

/** `definitionId` of the Content types section: the lazily loaded content type picker. */
export function MetaobjectDefinitionWidget({ id, label, help, value, onChange, error }: SettingWidgetProps) {
  return (
    <Suspense
      fallback={(
        <div className="space-y-1.5">
          <Label htmlFor={id}>{label}</Label>
          <Skeleton className="h-11 w-full sm:h-9" />
        </div>
      )}
    >
      <MetaobjectDefinitionField
        id={id}
        label={label}
        help={help}
        value={typeof value === "string" ? value : ""}
        onChange={onChange}
        error={error()}
      />
    </Suspense>
  );
}
