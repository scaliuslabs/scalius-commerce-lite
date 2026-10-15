/**
 * The Content types section's content type: a picker over the types the
 * online store may show (their "Show on the online store" switch is on),
 * with a hint and a link to Content types when there are none or the chosen
 * one is private or gone. Loaded on first use so the theme editor's first
 * download stays small.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { objectMessages } from "~/i18n/objects";
import { objectTypesQueryOptions } from "~/lib/api-query-options/objects";
import { Field } from "~/components/ui/field";

export function ObjectTypeField({ id, label, help, value, onChange, error }: {
  id: string;
  label: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}) {
  const t = useMessages(objectMessages);
  const types = useQuery(objectTypesQueryOptions());
  const all = types.data ?? [];
  const shown = all.filter((type) => type.storefront);
  const chosen = value ? all.find((type) => type.handle === value) : undefined;
  const hint = types.isError
    ? t("pickerFailed")
    : !types.isSuccess
      ? null
      : value && !chosen
        ? t("pickerGone")
        : chosen && !chosen.storefront
          ? t("pickerPrivate")
          : shown.length === 0 && !value
            ? t("pickerNone")
            : null;
  // The chosen type stays in the list even when it is private or gone, so the field shows what the section holds.
  const options = [
    ...shown.map((type) => ({ value: type.handle, label: type.name, description: type.handle })),
    ...(value && !shown.some((type) => type.handle === value) ? [{ value, label: chosen?.name ?? value }] : []),
  ];
  const note = error ?? hint ?? help;
  return (
    <Field id={id} label={label}>
      <SearchableSelect
        id={id}
        value={value}
        options={options}
        clearable
        busy={types.isPending}
        placeholder={t("pickerPlaceholder")}
        searchPlaceholder={t("pickerSearch")}
        emptyMessage={t("pickerEmpty")}
        onValueChange={(next) => onChange(next)}
        triggerClassName="w-full"
        aria-invalid={error || (hint && value) ? true : undefined}
        aria-describedby={note ? `${id}-note` : undefined}
      />
      {note ? (
        <p id={`${id}-note`} role={error ? "alert" : undefined} className={error ? "text-body text-destructive" : "text-body text-muted-foreground"}>
          {note}
        </p>
      ) : null}
      {hint ? (
        <Link to="/admin/objects" target="_blank" rel="noopener" className="inline-block text-body text-link underline">
          {t("pickerManage")}
        </Link>
      ) : null}
    </Field>
  );
}
