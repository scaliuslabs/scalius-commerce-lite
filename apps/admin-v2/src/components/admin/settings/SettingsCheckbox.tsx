import type { ReactNode } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { ChoiceField } from "~/components/ui/field";

/**
 * A yes/no that is saved with the page's save bar or the dialog's Save: a
 * checkbox with its label after it and help under the label (DESIGN F9). A
 * setting that applies at once is a `Switch` instead. Help is `<id>-help`.
 */
export function SettingsCheckbox({
  id,
  label,
  help,
  error,
  checked,
  disabled,
  onCheckedChange,
}: {
  id: string;
  label: ReactNode;
  help?: ReactNode;
  error?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const noteId = error ? `${id}-error` : help ? `${id}-help` : undefined;
  return (
    <ChoiceField
      id={id}
      label={label}
      help={help}
      error={error}
      control={
        <Checkbox
          id={id}
          checked={checked}
          disabled={disabled}
          aria-invalid={error ? true : undefined}
          aria-describedby={noteId}
          onCheckedChange={(value) => onCheckedChange(value === true)}
        />
      }
    />
  );
}
