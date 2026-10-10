import { useState } from "react";
import { Input } from "~/components/ui/input";
import { FieldSet } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { appListColumnsMessages } from "~/i18n/app-list-columns";
import {
  appFilterColumnKey,
  appFilterValue,
  useAppResourceColumns,
  type AppListColumn,
  type AppListResource,
} from "./ui/list-columns";

interface AppListFilterProps {
  resource: AppListResource;
  /** The list's `appFilter` URL value: `<app id>/<column id>:<value>`. */
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  /** Show the field's name above the controls (a filter panel); lists with a row of filters leave it out. */
  labelled?: boolean;
}

const YES_NO = ["true", "false"] as const;

/** The filter value for what was typed, or null when it cannot be one (an amount is in major units, as the API takes it). */
function storedValue(column: AppListColumn, typed: string): string | null {
  if (column.type !== "money" && column.type !== "number") return typed;
  const amount = Number(typed);
  return typed.trim() === "" || !Number.isFinite(amount) || (column.type === "money" && amount < 0) ? null : typed.trim();
}

/**
 * Filters a list by one app column, exact value: the column, then the value
 * (Yes or No for a yes/no column). The filter reaches the URL when the value
 * is set (Enter, or leaving the field), never on each keystroke.
 */
export function AppListFilter({ resource, value, onChange, labelled = false }: AppListFilterProps) {
  const t = useMessages(appListColumnsMessages);
  const { all } = useAppResourceColumns(resource);
  const filterable = all.filter((column) => column.filterable);

  const urlKey = value ? appFilterColumnKey(value) : "";
  const [key, setKey] = useState(urlKey);
  const column = filterable.find((entry) => entry.key === key);
  const urlText = appFilterValue(value);
  const [draft, setDraft] = useState(urlText);
  // The URL changed from outside (Clear filters, a link): the fields follow it.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setKey(urlKey);
    setDraft(urlText);
  }

  const stored = column ? storedValue(column, draft) : null;
  const invalid = draft.trim() !== "" && stored === null;
  const commit = (next: string) => {
    if (!column) return;
    if (next.trim() === "") {
      onChange(undefined);
      return;
    }
    const text = storedValue(column, next);
    if (text !== null) onChange(`${column.key}:${text}`);
  };

  const controls = (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <SearchableSelect
        value={key}
        onValueChange={(next) => {
          setKey(next);
          setDraft("");
          // A different column starts without the old column's value.
          if (value) onChange(undefined);
        }}
        options={filterable.map((entry) => ({ value: entry.key, label: entry.title, description: entry.appName }))}
        placeholder={t("filterColumnPlaceholder")}
        ariaLabel={t("filterColumn")}
        clearable
        triggerClassName="w-full shrink-0 sm:w-auto sm:min-w-40"
      />
      {column?.type === "boolean" ? (
        <SearchableSelect
          value={draft}
          onValueChange={(next) => {
            setDraft(next);
            commit(next);
          }}
          options={YES_NO.map((option) => ({ value: option, label: option === "true" ? t("yes") : t("no") }))}
          placeholder={t("filterValue")}
          ariaLabel={t("filterValue")}
          clearable
          triggerClassName="w-full shrink-0 sm:w-auto sm:min-w-28"
        />
      ) : (
        <Input
          value={draft}
          disabled={!column}
          aria-label={t("filterValue")}
          aria-invalid={invalid || undefined}
          placeholder={t("filterValuePlaceholder")}
          inputMode={column?.type === "number" || column?.type === "money" ? "decimal" : undefined}
          className="w-full sm:w-44"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => draft !== urlText && commit(draft)}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit(draft);
          }}
        />
      )}
    </div>
  );

  if (!labelled) return controls;
  return (
    <FieldSet label={t("filterLabel")}>{controls}</FieldSet>
  );
}
