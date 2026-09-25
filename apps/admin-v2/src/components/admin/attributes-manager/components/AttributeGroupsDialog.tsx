import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminAttributesGroupsByGroupId,
  patchApiV1AdminAttributesGroupsByGroupId,
  postApiV1AdminAttributesGroups,
  putApiV1AdminAttributesGroupsOrder,
} from "@scalius/api-client/sdk";
import { ATTRIBUTE_GROUP_NAME_MAX_LENGTH } from "@scalius/shared/catalog-attributes";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import { queryKeys } from "~/lib/query-keys";
import { attributeGroupsQueryOptions, type AttributeGroupDto } from "~/lib/api-query-options/attributes";
import { formatNumber, useMessages } from "~/i18n";
import { attributeTypeMessages } from "~/i18n/attribute-types";

/**
 * The specification table's sections: add, rename, reorder and delete.
 * Each change saves at once (like the values editor); deleting a group
 * leaves its attributes ungrouped.
 */
export function AttributeGroupsDialog({ open, onClose, canEdit }: { open: boolean; onClose: () => void; canEdit: boolean }) {
  const t = useMessages(attributeTypeMessages);
  const queryClient = useQueryClient();
  const { data, isPending } = useQuery({ ...attributeGroupsQueryOptions(), enabled: open });
  const groups = data?.groups ?? [];
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<AttributeGroupDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.attributes.all });
  const run = useMutation({
    mutationFn: (action: () => Promise<unknown>) => action(),
    onSuccess: () => setError(null),
    onError: (failure) => setError(getServerFnError(failure, t("actionFailed"))),
    onSettled: () => void refresh(),
  });

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    run.mutate(async () => {
      await apiData(postApiV1AdminAttributesGroups({ body: { name } }));
      setNewName("");
      toast.success(t("groupSaved"));
    });
  };
  const rename = () => {
    if (!renaming?.name.trim()) return;
    const { id, name } = renaming;
    run.mutate(async () => {
      await apiData(patchApiV1AdminAttributesGroupsByGroupId({ path: { groupId: id }, body: { name: name.trim() } }));
      setRenaming(null);
      toast.success(t("groupSaved"));
    });
  };
  const move = (index: number, step: -1 | 1) => {
    const next = [...groups];
    const [moved] = next.splice(index, 1);
    next.splice(index + step, 0, moved!);
    run.mutate(() => apiData(putApiV1AdminAttributesGroupsOrder({
      body: { items: next.map((group, position) => ({ groupId: group.id, sortOrder: position })) },
    })));
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("manageGroups")}</DialogTitle>
            <DialogDescription>{t("groupsHelp")}</DialogDescription>
          </DialogHeader>
          {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
          {isPending ? <Skeleton className="h-24 w-full" /> : groups.length === 0 ? (
            <p className="text-body text-muted-foreground">{t("noGroups")}</p>
          ) : (
            <ul className="max-h-80 divide-y overflow-y-auto rounded-lg border">
              {groups.map((group, index) => (
                <li key={group.id} className="flex items-center gap-2 px-3 py-2">
                  {renaming?.id === group.id ? (
                    <form
                      method="post"
                      className="flex min-w-0 flex-1 gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        rename();
                      }}
                    >
                      <Input
                        autoFocus
                        aria-label={t("groupName")}
                        maxLength={ATTRIBUTE_GROUP_NAME_MAX_LENGTH}
                        value={renaming.name}
                        onChange={(event) => setRenaming({ id: group.id, name: event.target.value })}
                      />
                      <Button type="submit" loading={run.isPending}>{t("save")}</Button>
                      <Button type="button" variant="ghost" onClick={() => setRenaming(null)}>{t("cancel")}</Button>
                    </form>
                  ) : (
                    <>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-body font-medium">{group.name}</p>
                        <p className="text-body text-muted-foreground">{t("attributesInGroup", { count: formatNumber(group.attributeCount) })}</p>
                      </div>
                      {canEdit ? (
                        <>
                          <Button type="button" variant="ghost" size="icon" disabled={index === 0 || run.isPending} aria-label={t("moveUp", { name: group.name })} onClick={() => move(index, -1)}>
                            <ArrowUp className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" disabled={index === groups.length - 1 || run.isPending} aria-label={t("moveDown", { name: group.name })} onClick={() => move(index, 1)}>
                            <ArrowDown className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" aria-label={t("renameGroup", { name: group.name })} onClick={() => setRenaming({ id: group.id, name: group.name })}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" aria-label={t("deleteGroup", { name: group.name })} onClick={() => setDeleting(group)}>
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </>
                      ) : null}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit ? (
            <form
              method="post"
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                add();
              }}
            >
              <Label htmlFor="attribute-group-name">{t("groupName")}</Label>
              <div className="flex gap-2">
                <Input
                  id="attribute-group-name"
                  maxLength={ATTRIBUTE_GROUP_NAME_MAX_LENGTH}
                  placeholder={t("groupNamePlaceholder")}
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                />
                <Button type="submit" variant="outline" disabled={!newName.trim()} loading={run.isPending && Boolean(newName.trim())}>
                  {t("addGroup")}
                </Button>
              </div>
            </form>
          ) : null}
          <DialogFooter>
            <Button type="button" onClick={onClose}>{t("done")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => !next && setDeleting(null)}
        title={t("deleteGroupTitle", { name: deleting?.name ?? "" })}
        description={t("deleteGroupBody")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        isLoading={run.isPending}
        onConfirm={() => {
          const target = deleting;
          if (!target) return;
          run.mutate(async () => {
            await apiData(deleteApiV1AdminAttributesGroupsByGroupId({ path: { groupId: target.id } }));
            setDeleting(null);
            toast.success(t("groupDeleted"));
          });
        }}
      />
    </>
  );
}
