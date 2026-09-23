import { useEffect, useState } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ListTree, Plus } from "lucide-react";
import { toast } from "sonner";
import {
  deleteApiV1AdminNavigationMenusByMenuId,
  deleteApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  patchApiV1AdminNavigationMenusByMenuId,
  postApiV1AdminNavigationMenusByMenuIdItemsByItemIdMove,
  postApiV1AdminNavigationMenusByMenuIdPublish,
  postApiV1AdminNavigationMenusByMenuIdRollback,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { SaveBarProvider, useSaveBar } from "~/components/admin/shared/SaveBar";
import { apiData } from "~/lib/api";
import {
  navigationMenuQueryOptions,
  navigationMenusQueryOptions,
  navigationPlacementsQueryOptions,
} from "~/lib/api-query-options/online-store";
import type { NavigationMenuItemRow } from "~/lib/api-query-options/navigation";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { MenuItemDialog, type MenuItemTarget } from "./MenuItemDialog";
import { MenuTree, type MoveDestination } from "./MenuTree";
import { actionErrorText, failSave, Field, OnlineStorePage, SectionCard } from "./shared";

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
  const [dialog, setDialog] = useState<MenuItemTarget | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deletingItem, setDeletingItem] = useState<NavigationMenuItemRow | null>(null);
  const [removing, setRemoving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // A deleted menu has nothing left to save: leave without the unsaved-changes prompt.
  const [deleted, setDeleted] = useState(false);
  useEffect(() => {
    if (deleted) void navigate({ to: "/admin/online-store/navigation" });
  }, [deleted, navigate]);
  const nameChanged = name.trim() !== menu.name;
  const unpublished = menu.revision !== menu.publishedRevision;

  useSaveBar({
    label: menu.name,
    fields: { name: "menu-name" },
    dirty: !deleted && (nameChanged || unpublished),
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
        .catch((error) => toast.error(t("saveFailed"), { description: actionErrorText(error) }))
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
      toast.error(t("moveFailed"), { description: actionErrorText(error) });
    }
    await queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
  };

  const deleteItem = async (item: NavigationMenuItemRow) => {
    setRemoving(true);
    try {
      await apiData(deleteApiV1AdminNavigationMenusByMenuIdItemsByItemId({
        path: { menuId: menu.id, itemId: item.id },
        body: { expectedRevision: menu.revision },
      }));
      toast.success(t("itemDeleted"));
      setDeletingItem(null);
    } catch (error) {
      toast.error(t("deleteFailed"), { description: actionErrorText(error) });
    } finally {
      setRemoving(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
    }
  };

  const deleteMenu = async () => {
    setDeleting(true);
    try {
      await apiData(deleteApiV1AdminNavigationMenusByMenuId({
        path: { menuId: menu.id },
        body: { expectedRevision: menu.revision },
      }));
      await queryClient.invalidateQueries({ queryKey: navigationMenusQueryOptions().queryKey });
      toast.success(t("menuDeleted"));
      setConfirmDelete(false);
      setDeleted(true);
    } catch (error) {
      toast.error(t("deleteFailed"), { description: actionErrorText(error) });
      setDeleting(false);
    }
  };

  return (
    <OnlineStorePage
      title={menu.name}
      back={{ to: "/admin/online-store/navigation", label: t("navigationTitle") }}
    >
      <Card className="p-4">
        <Field id="menu-name" label={t("menuName")} error={name.trim() ? undefined : t("menuNameRequired")}>
          <Input id="menu-name" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
      </Card>

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
              <p className="text-body text-muted-foreground">{t("emptyMenu")}</p>
            </div>
          }
          onEdit={(itemId) => setDialog({ itemId })}
          onDelete={setDeletingItem}
          onAddChild={(parentId) => setDialog({ itemId: "new", parentId })}
          onMove={(itemId, destination) => void move(itemId, destination)}
        />
      </SectionCard>

      <div className="flex flex-col items-end gap-1">
        <Button
          type="button"
          variant="outline"
          disabled={inUse}
          aria-describedby={inUse ? "menu-delete-note" : undefined}
          onClick={() => setConfirmDelete(true)}
        >
          {t("deleteMenu")}
        </Button>
        {inUse ? (
          <p id="menu-delete-note" className="text-right text-body text-muted-foreground">{t("deleteMenuInUse")}</p>
        ) : null}
      </div>

      <MenuItemDialog
        menu={menu}
        target={dialog}
        onClose={() => setDialog(null)}
        onSaved={() => {
          setDialog(null);
          void queryClient.invalidateQueries({ queryKey: queryKeys.navigation.menu(menu.id) });
        }}
      />
      <ConfirmDialog
        open={deletingItem !== null}
        onOpenChange={(open) => !open && setDeletingItem(null)}
        title={t("deleteItemTitle", { name: deletingItem?.label ?? "" })}
        description={t("deleteItemHelp")}
        confirmLabel={t("delete")}
        cancelLabel={t("cancel")}
        loadingLabel={t("deleting")}
        isLoading={removing}
        onConfirm={() => deletingItem && void deleteItem(deletingItem)}
      />
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
    </OnlineStorePage>
  );
}

export function MenuPage({ menuId }: { menuId: string }) {
  return (
    <SaveBarProvider>
      <MenuEditor menuId={menuId} />
    </SaveBarProvider>
  );
}
