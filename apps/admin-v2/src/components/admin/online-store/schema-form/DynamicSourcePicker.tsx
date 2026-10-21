import { BindingContext, DynamicSourceResource } from "./binding-context";
import { useContext, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BindingSettingType } from "@scalius/shared/storefront-theme/bindings";
import { Button } from "~/components/ui/button";
import { Field } from "~/components/ui/field";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useMessages } from "~/i18n";
import { dynamicSourceMessages } from "~/i18n/dynamic-sources";
import { apiClient, apiData } from "~/lib/api";
import { customFieldDefinitionsQueryOptions } from "~/lib/api-query-options/custom-fields";
import { objectTypesQueryOptions, type ObjectRecord } from "~/lib/api-query-options/objects";
import { dynamicSourceOptions, withSettingBinding, type DynamicSourceOption } from "./dynamic-sources";

export function DynamicSourcePicker({ id, path, type, label }: { id: string; path: string; type: BindingSettingType | null; label: string }) {
  const scope = useContext(BindingContext);
  const t = useMessages(dynamicSourceMessages);
  const [open, setOpen] = useState(false);
  if (!scope || !type) return null;
  path = scope.pathPrefix && path.startsWith(scope.pathPrefix) ? path.slice(scope.pathPrefix.length) : path;
  const source = scope.bindings?.[path]?.source;
  const full = !source && Object.keys(scope.bindings ?? {}).length >= 20;
  return (
    <div className="space-y-2" data-setting-source={path}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="ghost" size="sm" className="-ms-3 sm:-ms-2.5" aria-label={t("connectSetting", { name: label })} aria-expanded={open} aria-controls={`${id}-sources`} disabled={full} onClick={() => setOpen((value) => !value)}>
          {t(open ? "close" : source ? "connected" : "connect")}
        </Button>
        {source ? <Button type="button" variant="ghost" size="sm" onClick={() => scope.onChange(withSettingBinding(scope.bindings, path, null))}>{t("disconnect")}</Button> : null}
      </div>
      {source ? <p className="break-words text-body text-muted-foreground"><code>{source}</code></p> : null}
      {source || open ? <p className="text-body text-muted-foreground">{t("fallback")}</p> : null}
      {full ? <p className="text-body text-muted-foreground">{t("limit")}</p> : null}
      {open ? <SourceChoices id={`${id}-sources`} type={type} source={source} onChange={(next) => {
        scope.onChange(withSettingBinding(scope.bindings, path, next));
        setOpen(false);
      }} /> : null}
    </div>
  );
}

function SourceChoices({ id, type, source, onChange }: { id: string; type: BindingSettingType; source?: string; onChange: (source: string) => void }) {
  const t = useMessages(dynamicSourceMessages);
  const resource = useContext(DynamicSourceResource);
  const fields = useQuery({ ...customFieldDefinitionsQueryOptions(), enabled: resource !== null });
  const objects = useQuery(objectTypesQueryOptions());
  const [pending, setPending] = useState<DynamicSourceOption | null>(null);
  const options = dynamicSourceOptions(type, resource, fields.data?.definitions ?? [], objects.data ?? []);
  const failed = (resource && fields.isError) || objects.isError;
  return (
    <div id={id} className="space-y-3">
      <Field id={`${id}-choice`} label={t("source")}>
        <SearchableSelect
          value={pending?.value ?? source ?? ""}
          selectedLabel={source}
          options={options.map((option) => ({ ...option, label: option.group === "resource" ? t(option.label as "title" | "description" | "image" | "url") : option.label, group: t(option.group) }))}
          placeholder={t("choose")}
          emptyMessage={t("empty")}
          busy={objects.isPending || (resource !== null && fields.isPending)}
          maxVisibleOptions={100}
          triggerClassName="w-full"
          onValueChange={(value) => {
            const option = options.find((item) => item.value === value);
            if (option?.object) setPending(option);
            else if (option) onChange(option.value);
          }}
        />
      </Field>
      {failed ? <div role="alert" className="space-y-1"><p className="text-body text-destructive">{t("failed")}</p><Button type="button" variant="outline" size="sm" onClick={() => { void objects.refetch(); if (resource) void fields.refetch(); }}>{t("retry")}</Button></div> : null}
      {pending?.object ? <ObjectRecordChoice key={pending.value} id={`${id}-record`} target={pending.object} onChange={onChange} /> : null}
    </div>
  );
}

function ObjectRecordChoice({ id, target, onChange }: { id: string; target: { type: string; field: string }; onChange: (source: string) => void }) {
  const t = useMessages(dynamicSourceMessages);
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);
  const cursor = cursors.at(-1);
  const records = useQuery({
    queryKey: ["objects", "binding-records", target.type, cursor ?? ""],
    queryFn: () => apiData(apiClient.get<{ 200: { success: boolean; data: { records: ObjectRecord[]; nextCursor: string | null } } }>({
      url: `/api/v1/admin/objects/${encodeURIComponent(target.type)}`,
      query: { status: "published", limit: 25, ...(cursor ? { cursor } : {}) },
    })),
  });
  return (
    <div className="space-y-2">
      <Field id={id} label={t("record")}>
        <SearchableSelect value="" searchable={false} options={(records.data?.records ?? []).filter((record) => record.handle).map((record) => ({ value: record.handle!, label: record.displayName, description: record.handle! }))}
          placeholder={t("chooseRecord")} busy={records.isPending} triggerClassName="w-full"
          onValueChange={(handle) => onChange(`object.${target.type}.${handle}.${target.field}`)} />
      </Field>
      {records.isError ? <div role="alert"><p className="text-body text-destructive">{t("failed")}</p><Button type="button" variant="outline" size="sm" onClick={() => void records.refetch()}>{t("retry")}</Button></div> : null}
      {cursors.length > 1 || records.data?.nextCursor ? <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" size="sm" disabled={cursors.length === 1 || records.isPending} onClick={() => setCursors((values) => values.slice(0, -1))}>{t("previous")}</Button>
        <Button type="button" variant="outline" size="sm" disabled={!records.data?.nextCursor || records.isPending} onClick={() => setCursors((values) => [...values, records.data!.nextCursor!])}>{t("next")}</Button>
      </div> : null}
    </div>
  );
}
