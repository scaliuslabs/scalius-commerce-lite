import React from "react";
import { Loader2 } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Label } from "../../ui/label";
import { Switch } from "../../ui/switch";
import { SearchableSelect } from "../../ui/searchable-select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../ui/dialog";
import type { Location, LocationFormData } from "./hooks/useDeliveryLocations";

interface LocationFormDialogProps {
  open: boolean;
  onClose: () => void;
  activeTab: "city" | "zone" | "area";
  editMode: boolean;
  formData: LocationFormData;
  setFormData: React.Dispatch<React.SetStateAction<LocationFormData>>;
  isSubmitting: boolean;
  parentLocations: Location[];
  loadingParents: boolean;
  onSubmit: (e: React.SyntheticEvent) => void;
}

export function LocationFormDialog({
  open,
  onClose,
  activeTab,
  editMode,
  formData,
  setFormData,
  isSubmitting,
  parentLocations,
  loadingParents,
  onSubmit,
}: LocationFormDialogProps) {
  const locationLabel = activeTab.charAt(0).toUpperCase() + activeTab.slice(1);
  const parentLabel = activeTab === "zone" ? "City" : "Zone";
  const parentLabelLower = parentLabel.toLowerCase();
  const parentLabelPlural = parentLabel === "City" ? "cities" : "zones";
  const pathaoExternalId = formData.externalIds.pathao;
  const setPathaoExternalId = (value: string) => {
    setFormData((prev) => {
      const externalIds = { ...prev.externalIds };
      const trimmed = value.trim();

      if (!trimmed) {
        delete externalIds.pathao;
      } else {
        const numericValue = Number(trimmed);
        externalIds.pathao = Number.isFinite(numericValue) ? numericValue : trimmed;
      }

      return { ...prev, externalIds };
    });
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editMode ? "Edit" : "Add New"}{" "}
            {locationLabel}
          </DialogTitle>
          <DialogDescription>
            {editMode ? "Update" : "Create a new"} {activeTab} for delivery
            locations
          </DialogDescription>
        </DialogHeader>

        <form method="post" onSubmit={onSubmit} noValidate>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="name">
                Name <span className="text-red-500">*</span>
              </Label>
              <Input
                id="name"
                placeholder={`Enter ${activeTab} name`}
                value={formData.name}
                onChange={(e) =>
                  setFormData((prev) => ({ ...prev, name: e.target.value }))
                }
                required
              />
            </div>

            {activeTab !== "city" && (
              <div className="space-y-2">
                <Label htmlFor="parentId">
                  {activeTab === "zone" ? "City" : "Zone"}{" "}
                  <span className="text-red-500">*</span>
                </Label>
                <SearchableSelect
                  id="parentId"
                  value={formData.parentId}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      parentId: value,
                    }))
                  }
                  options={parentLocations.map((parent) => ({
                    value: parent.id,
                    label: `${parent.displayName ?? parent.name}${
                      parent.isActive ? "" : " (inactive)"
                    }`,
                    keywords: parent.displayName ? [parent.name] : undefined,
                    disabled: formData.isActive && !parent.isActive,
                  }))}
                  placeholder={
                    loadingParents
                      ? `Loading ${parentLabelPlural}…`
                      : `Select ${parentLabelLower}`
                  }
                  searchPlaceholder={`Search ${parentLabelPlural}…`}
                  emptyMessage={`No ${parentLabelPlural} found.`}
                  ariaLabel={`Parent ${parentLabelLower} for ${locationLabel.toLowerCase()}`}
                  triggerClassName="w-full"
                  maxVisibleOptions={100}
                  disabled={loadingParents}
                  required
                />
              </div>
            )}

            <div className="flex items-center space-x-2">
              <Switch
                id="isActive"
                checked={formData.isActive}
                onCheckedChange={(checked) =>
                  setFormData((prev) => ({
                    ...prev,
                    isActive: checked,
                    parentId: checked && parentLocations.some(
                      (parent) =>
                        parent.id === prev.parentId && !parent.isActive,
                    )
                      ? ""
                      : prev.parentId,
                  }))
                }
              />
              <Label htmlFor="isActive">Active</Label>
            </div>

            <div className="rounded-md border border-border bg-muted/30 p-3">
              <div className="space-y-2">
                <Label htmlFor="pathaoExternalId">Pathao {locationLabel} ID</Label>
                <Input
                  id="pathaoExternalId"
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  placeholder={`Pathao ${activeTab} ID`}
                  value={pathaoExternalId === undefined ? "" : String(pathaoExternalId)}
                  onChange={(event) => setPathaoExternalId(event.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Import fills this automatically; edit it when correcting Pathao shipment mappings.
                </p>
              </div>
            </div>
          </div>

          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              {isSubmitting && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {editMode ? "Save Changes" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
