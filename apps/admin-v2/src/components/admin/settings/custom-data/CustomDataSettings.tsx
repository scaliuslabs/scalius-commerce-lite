// Settings › Custom data (COMMERCE-HOOKS H4): the custom field definitions of
// one owner type at a time, in their display order. Add, edit, reorder and
// delete (deleting removes every value; the confirmation says how many). A
// plugin's fields are listed but only the plugin edits or deletes them.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, MoreHorizontal } from "lucide-react";
import { toast } from "~/lib/toast";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import {
  CUSTOM_FIELD_OWNER_TYPES,
  MERCHANT_CUSTOM_FIELD_WRITER,
  canWriteCustomFieldNamespace,
  customFieldItemType,
  isCustomFieldListType,
  type CustomFieldOwnerType,
} from "@scalius/shared/custom-fields";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { customFieldMessages, type CustomFieldMessageKey } from "~/i18n/custom-fields";
import { getServerFnError } from "~/lib/api-helpers";
import {
  customFieldDefinitionsQueryOptions,
  useDeleteCustomFieldDefinition,
  useReorderCustomFieldDefinitions,
  type CustomFieldDefinition,
  type CustomFieldDefinitionListItem,
} from "~/lib/api-query-options/custom-fields";
import { SettingsCard, SettingsCardLoading } from "../SettingsPage";
import { SettingsLoadFailure } from "../SettingsLoadFailure";
import { CustomFieldDefinitionDialog } from "./CustomFieldDefinitionDialog";

export function CustomDataSettings() {
  const t = useMessages(customFieldMessages);
  const canEdit = useHasPermission(PERMISSIONS.SETTINGS_GENERAL_EDIT);
  const [ownerType, setOwnerType] = useState<CustomFieldOwnerType>("product");
  const { data, isError, refetch } = useQuery(customFieldDefinitionsQueryOptions());
  const [editing, setEditing] = useState<{ definition: CustomFieldDefinition | null } | null>(null);
  const [deleting, setDeleting] = useState<CustomFieldDefinitionListItem | null>(null);
  const remove = useDeleteCustomFieldDefinition();
  const reorder = useReorderCustomFieldDefinitions();

  if (isError) return <SettingsLoadFailure title={t("loadFailed")} onRetry={refetch} />;
  if (!data) return <SettingsCardLoading />;

  const definitions = data.definitions.filter((definition) => definition.ownerType === ownerType);
  const typeLabel = (definition: CustomFieldDefinition) => {
    const item = t(`type.${customFieldItemType(definition.type)}` as CustomFieldMessageKey);
    return isCustomFieldListType(definition.type) ? t("listOf", { type: item }) : item;
  };
  const move = (index: number, step: -1 | 1) => {
    const next = [...definitions];
    const [moved] = next.splice(index, 1);
    next.splice(index + step, 0, moved!);
    reorder.mutate(
      { ownerType, definitions: next.map((definition) => ({ id: definition.id, expectedRevision: definition.revision })) },
      {
        onSuccess: () => void toast.success(t("reordered")),
        onError: (error) => void toast.error(getServerFnError(error, t("reorderFailed"))),
      },
    );
  };

  return (
    <>
      <p className="text-body text-muted-foreground">{t("description")}</p>
      <SettingsCard
        id="customData"
        header={
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="text-heading-sm">{t(`owner.${ownerType}` as CustomFieldMessageKey)}</h2>
            <p className="text-body text-muted-foreground">{t("fieldCount", { count: definitions.length })}</p>
          </div>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <SearchableSelect
              id="custom-data-owner"
              value={ownerType}
              ariaLabel={t("title")}
              onValueChange={(value) => {
                const next = CUSTOM_FIELD_OWNER_TYPES.find((owner) => owner === value);
                if (next) setOwnerType(next);
              }}
              options={CUSTOM_FIELD_OWNER_TYPES.map((owner) => ({ value: owner, label: t(`owner.${owner}` as CustomFieldMessageKey) }))}
            />
            {canEdit ? <Button type="button" onClick={() => setEditing({ definition: null })}>{t("addField")}</Button> : null}
          </div>
        }
        rows={definitions.length === 0 ? (
          <div className="space-y-1 px-4 py-6 text-center">
            <p className="text-body font-medium">{t("noFields")}</p>
            <p className="text-body text-muted-foreground">{t("noFieldsBody")}</p>
          </div>
        ) : (
          <ul>
            {definitions.map((definition, index) => {
              const own = canWriteCustomFieldNamespace(MERCHANT_CUSTOM_FIELD_WRITER, definition.namespace);
              return (
                <li key={definition.id} className="flex items-start gap-2 border-b border-border px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-body font-medium">{definition.name}</span>
                      {definition.storefrontVisible ? <Badge variant="info">{t("storefront")}</Badge> : null}
                      {own ? null : <Badge variant="secondary">{t("managedBy", { namespace: definition.namespace })}</Badge>}
                    </p>
                    <p className="break-words text-body text-muted-foreground">
                      <code>{definition.namespace}.{definition.key}</code> · {typeLabel(definition)} · {t("valueCount", { count: definition.valueCount })}
                    </p>
                    {definition.description ? <p className="break-words text-body text-muted-foreground">{definition.description}</p> : null}
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 items-center">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("moveUp")}: ${definition.name}`}
                        disabled={index === 0 || reorder.isPending}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("moveDown")}: ${definition.name}`}
                        disabled={index === definitions.length - 1 || reorder.isPending}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown aria-hidden="true" />
                      </Button>
                      {own ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("actionsFor", { name: definition.name })}>
                              <MoreHorizontal aria-hidden="true" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={() => setEditing({ definition })}>{t("edit")}</DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => setDeleting(definition)}>{t("delete")}</DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      />
      <CustomFieldDefinitionDialog
        ownerType={editing?.definition?.ownerType ?? ownerType}
        definition={editing?.definition ?? null}
        open={editing !== null}
        onOpenChange={(open) => (open ? undefined : setEditing(null))}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={t("deleteTitle", { name: deleting?.name ?? "" })}
        description={deleting && deleting.valueCount > 0 ? t("deleteBody", { count: deleting.valueCount }) : t("deleteBodyEmpty")}
        confirmLabel={t("delete")}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (!deleting) return;
          remove.mutate({ id: deleting.id, expectedRevision: deleting.revision }, {
            onSuccess: () => {
              toast.success(t("deleted"));
              setDeleting(null);
            },
            onError: (error) => void toast.error(getServerFnError(error, t("deleteFailed"))),
          });
        }}
      />
    </>
  );
}
