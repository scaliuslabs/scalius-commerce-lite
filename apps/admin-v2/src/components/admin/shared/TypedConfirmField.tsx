/**
 * A typed confirmation for what cannot be undone (deleting an app's data for
 * good): the merchant types the thing's name before the destructive button
 * enables, so one stray click deletes nothing. Case and outer spaces do not
 * matter; the name itself does.
 */
import { Field } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

export { typedConfirmMatches } from "./typed-confirm";

export function TypedConfirmField({ phrase, value, onChange, disabled }: {
  phrase: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useMessages(resourceMessages);
  return (
    <Field label={t("typeToConfirm", { phrase })}>
      <Input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
    </Field>
  );
}
