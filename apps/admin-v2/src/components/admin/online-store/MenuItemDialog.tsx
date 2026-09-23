import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deleteApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  getApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  patchApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  postApiV1AdminNavigationMenusByMenuIdItems,
} from "@scalius/api-client/sdk";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { apiData } from "~/lib/api";
import { getServerFnError } from "~/lib/api-helpers";
import type {
  NavigationItemDraft,
  NavigationMenuItemRow,
  NavigationResourceType,
} from "~/lib/api-query-options/navigation";
import type { NavigationMenuRecord } from "~/lib/api-query-options/online-store";
import { queryKeys } from "~/lib/query-keys";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { NavigationResourcePicker } from "./NavigationResourcePicker";

type SystemKey = Extract<NavigationItemDraft["target"], { type: "system" }>["key"];
const SYSTEM_PAGES: SystemKey[] = ["home", "catalog", "search", "account", "cart", "checkout", "order_lookup"];
const RESOURCE_TYPES: NavigationResourceType[] = ["category", "collection", "product", "page"];
const LINK_TYPES = ["system", ...RESOURCE_TYPES, "external_url", "internal_path", "label"] as const;
type LinkType = (typeof LINK_TYPES)[number];

const EMPTY_DRAFT: NavigationItemDraft = {
  label: "",
  labelMode: "custom",
  target: { type: "system", key: "home" },
  openInNewTab: false,
  isEnabled: true,
};

function draftFromRow(item: NavigationMenuItemRow): NavigationItemDraft {
  const base = {
    label: item.label,
    labelMode: item.labelMode,
    openInNewTab: item.openInNewTab,
    isEnabled: item.isEnabled,
  };
  if ((RESOURCE_TYPES as string[]).includes(item.targetType)) {
    return {
      ...base,
      target: {
        type: "resource",
        resourceType: item.targetType as NavigationResourceType,
        resourceId: item.targetId ?? "",
        ...(item.targetQuery ? { query: item.targetQuery } : {}),
      },
    };
  }
  const custom = { ...base, labelMode: "custom" as const };
  if (item.targetType === "system") {
    return { ...custom, target: { type: "system", key: (item.targetValue ?? "home") as SystemKey } };
  }
  if (item.targetType === "internal_path") {
    return { ...custom, target: { type: "internal_path", path: item.targetValue ?? "/" } };
  }
  if (item.targetType === "external_url") {
    return { ...custom, target: { type: "external_url", url: item.targetValue ?? "https://" } };
  }
  return { ...custom, target: { type: "label" } };
}

function targetFor(type: LinkType): NavigationItemDraft["target"] {
  if ((RESOURCE_TYPES as string[]).includes(type)) {
    return { type: "resource", resourceType: type as NavigationResourceType, resourceId: "" };
  }
  if (type === "system") return { type: "system", key: "home" };
  if (type === "external_url") return { type: "external_url", url: "https://" };
  if (type === "internal_path") return { type: "internal_path", path: "/" };
  return { type: "label" };
}

function ItemForm({
  menu,
  itemId,
  parentId,
  initial,
  onClose,
  onSaved,
}: {
  menu: NavigationMenuRecord;
  itemId: string;
  parentId?: string;
  initial: NavigationItemDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const editing = itemId !== "new";
  const [draft, setDraft] = useState(initial);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const target = draft.target;
  const linkType: LinkType = target.type === "resource" ? target.resourceType : target.type;
  const valid = Boolean(draft.label.trim()) && (target.type !== "resource" || Boolean(target.resourceId));

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      onSaved();
    } catch (error) {
      toast.error(failure, { description: getServerFnError(error, t("tryAgain")) });
      setBusy(false);
    }
  };
  const save = () => run(
    () => editing
      ? apiData(patchApiV1AdminNavigationMenusByMenuIdItemsByItemId({
          path: { menuId: menu.id, itemId },
          body: { ...draft, expectedRevision: menu.revision },
        }))
      : apiData(postApiV1AdminNavigationMenusByMenuIdItems({
          path: { menuId: menu.id },
          body: { ...draft, expectedRevision: menu.revision, parentId: parentId ?? null },
        })),
    t(editing ? "itemSaved" : "itemAdded"),
    t("saveFailed"),
  );
  const remove = () => run(
    () => apiData(deleteApiV1AdminNavigationMenusByMenuIdItemsByItemId({
      path: { menuId: menu.id, itemId },
      body: { expectedRevision: menu.revision },
    })),
    t("itemDeleted"),
    t("deleteFailed"),
  );

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) void save();
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="menu-item-label">{t("itemLabel")}</Label>
        <Input
          id="menu-item-label"
          value={draft.label}
          maxLength={100}
          autoFocus
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value, labelMode: "custom" }))}
        />
      </div>
      <div className="space-y-1.5">
        <Label>{t("linkTo")}</Label>
        <Select
          value={linkType}
          onValueChange={(value) => setDraft((current) => ({ ...current, target: targetFor(value as LinkType) }))}
        >
          <SelectTrigger aria-label={t("linkTo")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LINK_TYPES.map((type) => (
              <SelectItem key={type} value={type}>{t(`link_${type}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {target.type === "resource" ? (
        <NavigationResourcePicker
          key={target.resourceType}
          id="menu-item-resource"
          type={target.resourceType}
          value={target.resourceId}
          fallbackLabel={editing ? draft.label : undefined}
          onValueChange={(resourceId, name) => setDraft((current) => ({
            ...current,
            ...(current.label.trim() ? {} : { label: name, labelMode: "resource" as const }),
            target: { ...target, resourceId },
          }))}
        />
      ) : null}
      {target.type === "system" ? (
        <Select
          value={target.key}
          onValueChange={(key) => setDraft((current) => ({ ...current, target: { type: "system", key: key as SystemKey } }))}
        >
          <SelectTrigger aria-label={t("link_system")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SYSTEM_PAGES.map((key) => (
              <SelectItem key={key} value={key}>{t(`system_${key}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {target.type === "internal_path" ? (
        <Input
          aria-label={t("link_internal_path")}
          placeholder="/search"
          value={target.path}
          onChange={(event) => setDraft((current) => ({ ...current, target: { type: "internal_path", path: event.target.value } }))}
        />
      ) : null}
      {target.type === "external_url" ? (
        <Input
          type="url"
          inputMode="url"
          aria-label={t("link_external_url")}
          value={target.url}
          onChange={(event) => setDraft((current) => ({ ...current, target: { type: "external_url", url: event.target.value } }))}
        />
      ) : null}
      <div className="space-y-3 rounded-lg border p-3">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="menu-item-visible">{t("showInMenu")}</Label>
          <Switch
            id="menu-item-visible"
            checked={draft.isEnabled !== false}
            onCheckedChange={(isEnabled) => setDraft((current) => ({ ...current, isEnabled }))}
          />
        </div>
        {target.type !== "label" ? (
          <div className="flex items-center justify-between gap-3 border-t pt-3">
            <Label htmlFor="menu-item-new-tab">{t("openInNewTab")}</Label>
            <Switch
              id="menu-item-new-tab"
              checked={draft.openInNewTab === true}
              onCheckedChange={(openInNewTab) => setDraft((current) => ({ ...current, openInNewTab }))}
            />
          </div>
        ) : null}
      </div>
      {confirmDelete ? (
        <div className="space-y-3 rounded-lg border border-destructive p-3">
          <p className="text-sm">{t("deleteItemHelp")}</p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setConfirmDelete(false)}>{t("cancel")}</Button>
            <Button type="button" variant="destructive" disabled={busy} onClick={() => void remove()}>
              {t("delete")}
            </Button>
          </div>
        </div>
      ) : (
        <DialogFooter className="gap-2 sm:justify-between">
          {editing ? (
            <Button type="button" variant="ghost" onClick={() => setConfirmDelete(true)}>{t("delete")}</Button>
          ) : <span />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>{t("cancel")}</Button>
            <Button type="submit" disabled={!valid || busy}>{t(editing ? "save" : "add")}</Button>
          </div>
        </DialogFooter>
      )}
    </form>
  );
}

/** Add or edit one menu item; saves straight into the menu's unpublished draft. */
export function MenuItemDialog({
  menu,
  itemId,
  parentId,
  onClose,
  onSaved,
}: {
  menu: NavigationMenuRecord;
  itemId: string;
  parentId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const editing = itemId !== "new";
  const itemQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(menu.id), "item", itemId],
    queryFn: () => apiData(getApiV1AdminNavigationMenusByMenuIdItemsByItemId({ path: { menuId: menu.id, itemId } })),
    enabled: editing,
  });
  const initial = editing ? (itemQuery.data ? draftFromRow(itemQuery.data.item) : null) : EMPTY_DRAFT;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(editing ? "editMenuItem" : "addMenuItem")}</DialogTitle>
          <DialogDescription>{t("menuItemHelp")}</DialogDescription>
        </DialogHeader>
        {initial ? (
          <ItemForm
            menu={menu}
            itemId={itemId}
            parentId={parentId}
            initial={initial}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : itemQuery.isError ? (
          <p className="text-sm text-destructive">{t("loadFailed")}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
