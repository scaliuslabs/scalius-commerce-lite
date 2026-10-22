/**
 * A typed confirmation for what cannot be undone (deleting an app's data for
 * good): the merchant types the thing's name before the destructive button
 * enables, so one stray click deletes nothing. Case and outer spaces do not
 * matter; the name itself does.
 */
import { useId } from "react";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { useMessages } from "~/i18n";
import { resourceMessages } from "~/i18n/resource";

/** Whether what was typed confirms the phrase. */
export function typedConfirmMatches(phrase: string, typed: string): boolean {
  return phrase.trim() !== "" && typed.trim().toLocaleLowerCase() === phrase.trim().toLocaleLowerCase();
}

export function TypedConfirmField({ phrase, value, onChange, disabled }: {
  phrase: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const t = useMessages(resourceMessages);
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("typeToConfirm", { phrase })}</Label>
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
    </div>
  );
}
