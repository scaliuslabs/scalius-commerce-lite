import { lazy, Suspense } from "react";
import { Skeleton } from "~/components/ui/skeleton";
import type { SettingWidgetProps } from "./SchemaSettingsForm";
import { Field } from "~/components/ui/field";

// The picker and its copy load when a Content types section is first edited.
const MetaobjectDefinitionField = lazy(() =>
  import("./MetaobjectDefinitionField").then((module) => ({ default: module.MetaobjectDefinitionField })),
);

/** `definitionId` of the Content types section: the lazily loaded content type picker. */
export function MetaobjectDefinitionWidget({ id, label, help, value, onChange, error }: SettingWidgetProps) {
  return (
    <Suspense
      fallback={(
        <Field id={id} label={label}>
          <Skeleton className="h-11 w-full sm:h-9" />
        </Field>
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
