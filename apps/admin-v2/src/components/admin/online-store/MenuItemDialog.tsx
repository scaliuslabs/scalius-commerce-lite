import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  getApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  patchApiV1AdminNavigationMenusByMenuIdItemsByItemId,
  postApiV1AdminNavigationMenusByMenuIdItems,
} from "@scalius/api-client/sdk";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
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
import { actionErrorText, Field, isWebAddress, normalizeWebAddress } from "./shared";

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
    return { ...custom, target: { type: "external_url", url: item.targetValue ?? "" } };
  }
  return { ...custom, target: { type: "label" } };
}

function targetFor(type: LinkType): NavigationItemDraft["target"] {
  if ((RESOURCE_TYPES as string[]).includes(type)) {
    return { type: "resource", resourceType: type as NavigationResourceType, resourceId: "" };
  }
  if (type === "system") return { type: "system", key: "home" };
  if (type === "external_url") return { type: "external_url", url: "" };
  if (type === "internal_path") return { type: "internal_path", path: "/" };
  return { type: "label" };
}

/** Which item the dialog edits: an existing id, or "new" (optionally under a parent). */
export interface MenuItemTarget {
  itemId: string;
  parentId?: string;
}

function ItemForm({
  menu,
  target: { itemId, parentId },
  initial,
  onClose,
  onSaved,
}: {
  menu: NavigationMenuRecord;
  target: MenuItemTarget;
  initial: NavigationItemDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  const editing = itemId !== "new";
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const target = draft.target;
  const linkType: LinkType = target.type === "resource" ? target.resourceType : target.type;
  const [urlLeft, setUrlLeft] = useState(false);
  const urlValid = target.type !== "external_url" || isWebAddress(target.url);
  const valid = Boolean(draft.label.trim()) && urlValid && (target.type !== "resource" || Boolean(target.resourceId));
  const setTarget = (next: NavigationItemDraft["target"]) => setDraft((current) => ({ ...current, target: next }));

  const save = async () => {
    setBusy(true);
    setError(undefined);
    const body = target.type === "external_url"
      ? { ...draft, target: { ...target, url: normalizeWebAddress(target.url) } }
      : draft;
    try {
      await apiData(editing
        ? patchApiV1AdminNavigationMenusByMenuIdItemsByItemId({
            path: { menuId: menu.id, itemId },
            body: { ...body, expectedRevision: menu.revision },
          })
        : postApiV1AdminNavigationMenusByMenuIdItems({
            path: { menuId: menu.id },
            body: { ...body, expectedRevision: menu.revision, parentId: parentId ?? null },
          }));
      toast.success(t(editing ? "itemSaved" : "itemAdded"));
      onSaved();
    } catch (failure) {
      // Errors that block the edit stay in the dialog, above the fields.
      setError(actionErrorText(failure));
      setBusy(false);
    }
  };

  return (
    <form
      method="post"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (valid && !busy) void save();
      }}
    >
      {error ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("saveFailed")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <Field id="menu-item-label" label={t("itemLabel")} error={draft.label.trim() ? undefined : t("itemLabelRequired")}>
        <Input
          id="menu-item-label"
          value={draft.label}
          maxLength={100}
          autoFocus
          onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value, labelMode: "custom" }))}
        />
      </Field>
      <div className="space-y-1.5">
        <Label htmlFor="menu-item-link-type">{t("linkTo")}</Label>
        <Select value={linkType} onValueChange={(value) => setTarget(targetFor(value as LinkType))}>
          <SelectTrigger id="menu-item-link-type">
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
          onValueChange={({ id: resourceId, name }) => setDraft((current) => ({
            ...current,
            ...(current.label.trim() ? {} : { label: name, labelMode: "resource" as const }),
            target: { ...target, resourceId },
          }))}
        />
      ) : null}
      {target.type === "system" ? (
        <Select value={target.key} onValueChange={(key) => setTarget({ type: "system", key: key as SystemKey })}>
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
        <Field id="menu-item-path" label={t("link_internal_path")}>
          <Input
            id="menu-item-path"
            placeholder="/search"
            value={target.path}
            onChange={(event) => setTarget({ type: "internal_path", path: event.target.value })}
          />
        </Field>
      ) : null}
      {target.type === "external_url" ? (
        <Field id="menu-item-url" label={t("link_external_url")} error={urlLeft && !urlValid ? t("urlInvalid") : undefined}>
          <Input
            id="menu-item-url"
            type="url"
            inputMode="url"
            placeholder="https://example.com"
            value={target.url}
            aria-invalid={urlLeft && !urlValid ? true : undefined}
            // A pasted address that repeats "https://" is written once.
            onChange={(event) => setTarget({ type: "external_url", url: event.target.value.replace(/^(?:https?:\/+)+(?=https?:)/i, "") })}
            onBlur={() => {
              setUrlLeft(true);
              setTarget({ type: "external_url", url: normalizeWebAddress(target.url) });
            }}
          />
        </Field>
      ) : null}
      <div className="rounded-lg border">
        <div className="flex items-center justify-between gap-3 px-3 py-2">
          <Label htmlFor="menu-item-visible">{t("showInMenu")}</Label>
          <Switch
            id="menu-item-visible"
            checked={draft.isEnabled !== false}
            onCheckedChange={(isEnabled) => setDraft((current) => ({ ...current, isEnabled }))}
          />
        </div>
        {target.type !== "label" ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-3 py-2">
            <Label htmlFor="menu-item-new-tab">{t("openInNewTab")}</Label>
            <Switch
              id="menu-item-new-tab"
              checked={draft.openInNewTab === true}
              onCheckedChange={(openInNewTab) => setDraft((current) => ({ ...current, openInNewTab }))}
            />
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>{t("cancel")}</Button>
        <Button type="submit" loading={busy} disabled={!valid}>{t(editing ? "save" : "add")}</Button>
      </DialogFooter>
    </form>
  );
}

/** Add or edit one menu item; saves straight into the menu's unpublished draft. */
export function MenuItemDialog({
  menu,
  target,
  onClose,
  onSaved,
}: {
  menu: NavigationMenuRecord;
  /** The item being edited; null closes the dialog (it stays mounted). */
  target: MenuItemTarget | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useMessages(onlineStoreMessages);
  // Keep the last item while the dialog animates closed.
  const [shown, setShown] = useState(target);
  const [opened, setOpened] = useState(0);
  if (target && target !== shown) {
    setShown(target);
    setOpened((count) => count + 1);
  }
  const itemId = shown?.itemId ?? "new";
  const editing = itemId !== "new";
  const itemQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(menu.id), "item", itemId],
    queryFn: () => apiData(getApiV1AdminNavigationMenusByMenuIdItemsByItemId({ path: { menuId: menu.id, itemId } })),
    enabled: editing && target !== null,
  });
  const initial = editing ? (itemQuery.data ? draftFromRow(itemQuery.data.item) : null) : EMPTY_DRAFT;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t(editing ? "editMenuItem" : "addMenuItem")}</DialogTitle>
          <DialogDescription>{t("menuItemHelp")}</DialogDescription>
        </DialogHeader>
        {shown && initial ? (
          <ItemForm
            key={`${opened}:${itemQuery.dataUpdatedAt}`}
            menu={menu}
            target={shown}
            initial={initial}
            onClose={onClose}
            onSaved={onSaved}
          />
        ) : itemQuery.isError ? (
          <p role="alert" className="text-body text-destructive">{t("loadFailed")}</p>
        ) : (
          <p className="text-body text-muted-foreground">{t("loading")}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}
