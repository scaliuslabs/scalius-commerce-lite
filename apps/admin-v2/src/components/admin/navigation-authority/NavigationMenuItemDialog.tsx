import { useEffect, useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { FieldError, InlineHelp } from "~/components/admin/shell";
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
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { getServerFnError } from "~/lib/api-helpers";
import {
  createNavigationMenuItemAuthority,
  getNavigationMenuItemAuthority,
  updateNavigationMenuItemAuthority,
  type NavigationItemDraft,
  type NavigationMenuSummary,
} from "~/lib/api-functions/navigation-authority";
import { queryKeys } from "~/lib/query-keys";

import { NavigationResourcePicker } from "./NavigationResourcePicker";
import {
  SYSTEM_DESTINATIONS,
  isResourceTargetType,
  itemRowToDraft,
} from "./navigation-authority-model";

interface NavigationMenuItemDialogProps {
  menu: NavigationMenuSummary;
  /** `"new"` creates an item; any other id edits that item. */
  itemId: string;
  /** Parent for a new item. Ignored when editing. */
  parentId?: string;
  parentLabel?: string;
  onClose: () => void;
  onSaved: () => void;
}

const EMPTY_DRAFT: NavigationItemDraft = {
  label: "",
  labelMode: "custom",
  target: { type: "internal_path", path: "/" },
  openInNewTab: false,
  isEnabled: true,
};

/**
 * One form for adding and editing a menu item. Every level's "Add menu item"
 * row opens it with the parent already chosen, so the tree never asks the
 * operator to pick a parent twice.
 */
export function NavigationMenuItemDialog({
  menu,
  itemId,
  parentId,
  parentLabel,
  onClose,
  onSaved,
}: NavigationMenuItemDialogProps) {
  const editing = itemId !== "new";
  const fieldId = useId();
  const itemQuery = useQuery({
    queryKey: [...queryKeys.navigation.menu(menu.id), "item", itemId],
    queryFn: () => getNavigationMenuItemAuthority({ data: { menuId: menu.id, itemId } }),
    enabled: editing,
  });
  const [draft, setDraft] = useState<NavigationItemDraft>(EMPTY_DRAFT);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (itemQuery.data?.item) setDraft(itemRowToDraft(itemQuery.data.item));
  }, [itemQuery.data?.item]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (editing) {
        return updateNavigationMenuItemAuthority({
          data: { ...draft, menuId: menu.id, itemId, expectedRevision: menu.revision },
        });
      }
      return createNavigationMenuItemAuthority({
        data: {
          ...draft,
          menuId: menu.id,
          expectedRevision: menu.revision,
          parentId: parentId ?? null,
        },
      });
    },
    onSuccess: () => {
      toast.success(editing ? "Menu item updated" : "Menu item added");
      onSaved();
    },
    onError: (error) =>
      toast.error("Menu item was not saved", {
        description: getServerFnError(error, "Menu item was not saved"),
      }),
  });

  const targetType = draft.target.type === "resource" ? draft.target.resourceType : draft.target.type;
  const selectedResourceId = draft.target.type === "resource" ? draft.target.resourceId : "";
  const labelError = !draft.label.trim() ? "Enter the text customers will see." : null;
  const resourceError = draft.target.type === "resource" && !draft.target.resourceId
    ? "Choose which item this links to."
    : null;
  const canSave = !labelError && !resourceError;

  const changeTargetType = (value: string) => {
    if (isResourceTargetType(value)) {
      setDraft((current) => ({
        ...current,
        labelMode: "resource",
        target: { type: "resource", resourceType: value, resourceId: "" },
      }));
      return;
    }
    if (value === "system") {
      setDraft((current) => ({
        ...current,
        labelMode: "custom",
        target: { type: "system", key: "home" },
      }));
    } else if (value === "external_url") {
      setDraft((current) => ({
        ...current,
        labelMode: "custom",
        target: { type: "external_url", url: "https://" },
      }));
    } else if (value === "label") {
      setDraft((current) => ({ ...current, labelMode: "custom", target: { type: "label" } }));
    } else {
      setDraft((current) => ({
        ...current,
        labelMode: "custom",
        target: { type: "internal_path", path: "/" },
      }));
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit menu item" : "Add menu item"}</DialogTitle>
          <DialogDescription>
            {editing
              ? "Changes are saved as a draft until you publish the menu."
              : parentLabel
                ? `Added under "${parentLabel}" as a draft until you publish the menu.`
                : "Added to the top level as a draft until you publish the menu."}
          </DialogDescription>
        </DialogHeader>

        {editing && itemQuery.isLoading ? (
          <div className="space-y-4 py-1" data-testid="navigation-item-loading">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ) : (
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label htmlFor={`${fieldId}-label`}>Label</Label>
              <Input
                id={`${fieldId}-label`}
                value={draft.label}
                maxLength={100}
                autoFocus
                aria-invalid={showErrors && Boolean(labelError)}
                aria-describedby={`${fieldId}-label-help`}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, label: event.target.value }))}
              />
              {showErrors && labelError ? (
                <FieldError id={`${fieldId}-label-help`}>{labelError}</FieldError>
              ) : (
                <InlineHelp id={`${fieldId}-label-help`}>
                  {draft.labelMode === "resource"
                    ? "The published menu shows the source title instead of this text."
                    : "Customers see this text in the menu."}
                </InlineHelp>
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-target`}>Destination</Label>
                <Select value={targetType} onValueChange={changeTargetType}>
                  <SelectTrigger id={`${fieldId}-target`} className="min-h-11 sm:min-h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="system">Store page</SelectItem>
                    <SelectItem value="category">Category</SelectItem>
                    <SelectItem value="collection">Collection</SelectItem>
                    <SelectItem value="product">Product</SelectItem>
                    <SelectItem value="page">Page</SelectItem>
                    <SelectItem value="internal_path">Store path</SelectItem>
                    <SelectItem value="external_url">Web address</SelectItem>
                    <SelectItem value="label">Heading only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {draft.target.type === "resource" && (
                <div className="space-y-1.5">
                  <Label htmlFor={`${fieldId}-label-mode`}>Label source</Label>
                  <Select
                    value={draft.labelMode}
                    onValueChange={(value: "custom" | "resource") =>
                      setDraft((current) => ({ ...current, labelMode: value }))}
                  >
                    <SelectTrigger id={`${fieldId}-label-mode`} className="min-h-11 sm:min-h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="resource">Follow source title</SelectItem>
                      <SelectItem value="custom">Keep custom label</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            {draft.target.type === "resource" && (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`${fieldId}-resource`}>Resource</Label>
                  <NavigationResourcePicker
                    key={draft.target.resourceType}
                    id={`${fieldId}-resource`}
                    type={draft.target.resourceType}
                    value={selectedResourceId}
                    fallbackLabel={draft.label}
                    onValueChange={(resourceId) =>
                      setDraft((current) => current.target.type === "resource"
                        ? { ...current, target: { ...current.target, resourceId } }
                        : current)}
                  />
                  {showErrors && resourceError ? (
                    <FieldError>{resourceError}</FieldError>
                  ) : null}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`${fieldId}-query`}>Optional query</Label>
                  <Input
                    id={`${fieldId}-query`}
                    placeholder="?sort=newest"
                    value={draft.target.query ?? ""}
                    aria-describedby={`${fieldId}-query-help`}
                    onChange={(event) =>
                      setDraft((current) => current.target.type === "resource"
                        ? { ...current, target: { ...current.target, query: event.target.value } }
                        : current)}
                  />
                  <InlineHelp id={`${fieldId}-query-help`}>
                    Appended to the destination link, for example a preset sort.
                  </InlineHelp>
                </div>
              </>
            )}

            {draft.target.type === "system" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-system`}>Store page</Label>
                <Select
                  value={draft.target.key}
                  onValueChange={(key: Extract<
                    NavigationItemDraft["target"],
                    { type: "system" }
                  >["key"]) =>
                    setDraft((current) => ({ ...current, target: { type: "system", key } }))}
                >
                  <SelectTrigger id={`${fieldId}-system`} className="min-h-11 sm:min-h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SYSTEM_DESTINATIONS.map(([key, label]) => (
                      <SelectItem key={key} value={key}>{label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {draft.target.type === "internal_path" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-path`}>Store path</Label>
                <Input
                  id={`${fieldId}-path`}
                  placeholder="/search"
                  value={draft.target.path}
                  aria-describedby={`${fieldId}-path-help`}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      target: { type: "internal_path", path: event.target.value },
                    }))}
                />
                <InlineHelp id={`${fieldId}-path-help`}>
                  Opens a path on this store, starting with a slash.
                </InlineHelp>
              </div>
            )}

            {draft.target.type === "external_url" && (
              <div className="space-y-1.5">
                <Label htmlFor={`${fieldId}-url`}>HTTPS address</Label>
                <Input
                  id={`${fieldId}-url`}
                  inputMode="url"
                  value={draft.target.url}
                  aria-describedby={`${fieldId}-url-help`}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      target: { type: "external_url", url: event.target.value },
                    }))}
                />
                <InlineHelp id={`${fieldId}-url-help`}>
                  Sends customers to another site.
                </InlineHelp>
              </div>
            )}

            <div className="grid gap-2 rounded-lg border border-border p-3">
              <label className="flex min-h-11 items-center justify-between gap-4 text-sm sm:min-h-9">
                <span>Visible in menu</span>
                <Switch
                  checked={draft.isEnabled !== false}
                  aria-label="Visible in menu"
                  onCheckedChange={(isEnabled) =>
                    setDraft((current) => ({ ...current, isEnabled }))}
                />
              </label>
              {draft.target.type !== "label" && (
                <label className="flex min-h-11 items-center justify-between gap-4 border-t border-border pt-2 text-sm sm:min-h-9">
                  <span>Open in new tab</span>
                  <Switch
                    checked={draft.openInNewTab === true}
                    aria-label="Open in new tab"
                    onCheckedChange={(openInNewTab) =>
                      setDraft((current) => ({ ...current, openInNewTab }))}
                  />
                </label>
              )}
            </div>
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            type="button"
            className="min-h-11 sm:min-h-9"
            disabled={saveMutation.isPending}
            onClick={() => {
              if (!canSave) {
                setShowErrors(true);
                return;
              }
              saveMutation.mutate();
            }}
          >
            {saveMutation.isPending ? "Saving" : editing ? "Save item" : "Add item"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default NavigationMenuItemDialog;
