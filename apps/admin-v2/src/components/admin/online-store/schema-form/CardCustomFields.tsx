import { useQuery } from "@tanstack/react-query";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { dynamicSourceMessages } from "~/i18n/dynamic-sources";
import { customFieldDefinitionsQueryOptions } from "~/lib/api-query-options/custom-fields";
import type { SetTheme, Theme } from "../theme-fields";
import { cardCustomFieldOptions } from "./dynamic-sources";

export function CardCustomFields({ theme, setDraft }: { theme: Theme; setDraft: SetTheme }) {
  const t = useMessages(dynamicSourceMessages);
  const definitions = useQuery(customFieldDefinitionsQueryOptions());
  const options = cardCustomFieldOptions(definitions.data?.definitions ?? []);
  const chosen = theme.blocks.card.fields ?? [];
  const change = (fields: string[]) => setDraft((current) => {
    const { fields: _fields, ...card } = current.blocks.card;
    return { ...current, blocks: { ...current.blocks, card: fields.length ? { ...card, fields } : card } };
  });
  return <div className="space-y-2">
    <Field id="card-custom-fields" label={t("cardFields")} help={t("cardFieldsHelp")}>
      <SearchableSelect value="" options={options.filter((option) => !chosen.includes(option.value))}
        placeholder={t("cardAdd")} disabled={chosen.length >= 3} busy={definitions.isPending} maxVisibleOptions={100} triggerClassName="w-full"
        onValueChange={(value) => { if (chosen.length < 3 && !chosen.includes(value)) change([...chosen, value]); }} />
    </Field>
    {chosen.length ? <ul className="space-y-1">
      {chosen.map((value) => {
        const name = options.find((option) => option.value === value)?.label ?? value;
        return <li key={value} className="flex items-center justify-between gap-2 text-body">
          <span className="min-w-0 break-words">{name}</span>
          <Button type="button" variant="ghost" size="sm" aria-label={t("removeField", { name })} onClick={() => change(chosen.filter((field) => field !== value))}>{t("remove")}</Button>
        </li>;
      })}
    </ul> : null}
    {definitions.isError ? <div role="alert" className="space-y-1"><p className="text-body text-destructive">{t("failed")}</p><Button type="button" variant="outline" size="sm" onClick={() => void definitions.refetch()}>{t("retry")}</Button></div> : null}
  </div>;
}
