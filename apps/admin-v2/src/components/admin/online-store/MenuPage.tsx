import { useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ListTree, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminNavigationMenusByMenuId,
  patchApiV1AdminNavigationMenusByMenuId,
  postApiV1AdminNavigationMenusByMenuIdItemsByItemIdMove,
  postApiV1AdminNavigationMenusByMenuIdPublish,
  postApiV1AdminNavigationMenusByMenuIdRollback,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, useSaveBar } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import {
  navigationMenuQueryOptions,
  navigationMenusQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { MenuItemDialog } from "./MenuItemDialog";
import { MenuTree, type MoveDestination } from "./MenuTree";
import { SectionCard, failSave } from "./shared";

type ItemDialogState = { itemId: string; parentId?: string } | null;

function MenuEditor({ menuId }: { menuId: string }) {
  const t = useMessages(onlineStoreMessages);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: menu } = useSuspenseQuery(navigationMenuQueryOptions(menuId));
  const { data: placements } = useSuspenseQuery(navigationPlacementsQueryOptions());
  const inUse = placements.some(({ placement }) => placement.menuId === menu.id && placement.isEnabled);
  // Menus, this menu and its items all live under one query-key prefix.
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menus() }),
    queryClient.invalidateQueries({ queryKey: navigationPlacementsQueryOptions().queryKey }),
  ]);
  const [name, setName] = useState(menu.name);
  const [savedName, setSavedName] = useState(menu.name);
  if (savedName !== menu.name) {
    setSavedName(menu.name);
    if (name === savedName) setName(menu.name);
  }
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<ItemDialogState>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const nameChanged = name.trim() !== menu.name;
  const unpublished = menu.revision !== menu.publishedRevision;

  useSaveBar({
    dirty: nameChanged || unpublished,
    saving,
    invalid: !name.trim(),
    save: async () => {
      setSaving(true);
      try {
        let revision = menu.revision;
        if (nameChanged) {
          revision = (await apiData(patchApiV1AdminNavigationMenusByMenuId({
            path: { menuId: menu.id },
            body: { expectedRevision: revision, name: name.trim(), handle: menu.handle },
          }))).revision;
        }
        await apiData(postApiV1AdminNavigationMenusByMenuIdPublish({
          path: { menuId: menu.id },
          body: { expectedRevision: revision },
        }));
      } catch (error) {
        failSave(error, () => void refresh());
      } finally {
        setSaving(false);
        await refresh();
      }
    },
    discard: () => {
      setName(menu.name);
      if (!unpublished || menu.publishedRevision == null) return;
      void apiData(postApiV1AdminNavigationMenusByMenuIdRollback({
        path: { menuId: menu.id },
        body: { expectedRevision: menu.revision, sourceRevision: menu.publishedRevision },
      }))
        .catch((error) => toast.error(t("saveFailed"), { description: getServerFnError(error, t("tryAgain")) }))
        .finally(() => void refresh());
    },
  });

  const move = async (itemId: string, destination: MoveDestination) => {
    try {
      await apiData(postApiV1AdminNavigationMenusByMenuIdItemsByItemIdMove({
        path: { menuId: menu.id, itemId },
        body: { expectedRevision: menu.revision, ...destination },
      }));
    } catch (error) {
      toast.error(t("moveFailed"), { description: getServerFnError(error, t("tryAgain")) });
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
  };

  const deleteMenu = async () => {
    setDeleting(true);
    try {
      await apiData(deleteApiV1AdminNavigationMenusByMenuId({
        path: { menuId: menu.id },
        body: { expectedRevision: menu.revision },
      }));
      queryClient.removeQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
      await queryClient.invalidateQueries({ queryKey: navigationMenusQueryOptions().queryKey });
      toast.success(t("menuDeleted"));
      void navigate({ to: "/admin/online-store/navigation" });
    } catch (error) {
      toast.error(t("deleteFailed"), { description: getServerFnError(error, t("tryAgain")) });
      setDeleting(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 pb-10">
      <div className="flex min-h-10 items-center gap-2">
        <Button asChild variant="ghost" size="icon" aria-label={t("navigationTitle")}>
          <Link to="/admin/online-store/navigation"><ArrowLeft /></Link>
        </Button>
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{menu.name}</h1>
      </div>

      <SectionCard title={t("menuName")}>
        <Input
          value={name}
          maxLength={100}
          aria-label={t("menuName")}
          aria-invalid={!name.trim()}
          onChange={(event) => setName(event.target.value)}
        />
      </SectionCard>

      <SectionCard
        title={t("menuItems")}
        action={
          <Button type="button" variant="outline" size="sm" onClick={() => setDialog({ itemId: "new" })}>
            <Plus /> {t("addMenuItem")}
          </Button>
        }
      >
        <MenuTree
          menu={menu}
          empty={
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <ListTree className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm text-muted-foreground">{t("emptyMenu")}</p>
            </div>
          }
          onEdit={(itemId) => setDialog({ itemId })}
          onAddChild={(parentId) => setDialog({ itemId: "new", parentId })}
          onMove={(itemId, destination) => void move(itemId, destination)}
        />
      </SectionCard>

      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={inUse}
          onClick={() => setConfirmDelete(true)}
        >
          {t("deleteMenu")}
        </Button>
      </div>
      {inUse ? (
        <p className="text-right text-sm text-muted-foreground">{t("deleteMenuInUse")}</p>
      ) : null}

      {dialog ? (
        <MenuItemDialog
          menu={menu}
          itemId={dialog.itemId}
          parentId={dialog.parentId}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteMenuTitle", { name: menu.name })}
        description={t("deleteMenuHelp")}
        confirmLabel={t("deleteMenu")}
        cancelLabel={t("cancel")}
        loadingLabel={t("deleting")}
        isLoading={deleting}
        onConfirm={() => void deleteMenu()}
      />
    </div>
  );
}

export function MenuPage({ menuId }: { menuId: string }) {
  return (
    <SaveBarProvider>
      <MenuEditor menuId={menuId} />
    </SaveBarProvider>
  );
}
