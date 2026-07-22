import { Plus, Search, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { SearchableSelect } from "../../ui/searchable-select";
import { useDeliveryLocations } from "./hooks/useDeliveryLocations";
import { LocationsTable } from "./LocationsTable";
import { LocationFormDialog } from "./LocationFormDialog";
import { DeleteConfirmationDialogs } from "./DeleteConfirmationDialogs";
import {
  PathaoImportButton,
  PathaoImportProgressBanner,
  PathaoImportConfirmDialog,
} from "./PathaoImportPanel";

export function DeliveryLocationsContainer() {
  const state = useDeliveryLocations();
  const labels = {
    city: { singular: "city", plural: "cities", title: "City" },
    zone: { singular: "zone", plural: "zones", title: "Zone" },
    area: { singular: "area", plural: "areas", title: "Area" },
  }[state.activeTab];

  return (
    <div className="space-y-4">
      {/* Pathao Import Progress Banner */}
      <PathaoImportProgressBanner
        importProgress={state.importProgress}
        importing={state.importing}
        onDismiss={() => state.setImportProgress(null)}
        onRetry={state.retryImport}
        onReset={state.resetImport}
      />

      <Tabs
        defaultValue="city"
        value={state.activeTab}
        onValueChange={(v) => {
          state.setActiveTab(v as "city" | "zone" | "area");
          state.setSelectedParent(null);
          state.setSearchQuery("");
        }}
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="h-auto w-full justify-start sm:w-auto">
            <TabsTrigger value="city" className="min-h-11 sm:min-h-9">Cities</TabsTrigger>
            <TabsTrigger value="zone" className="min-h-11 sm:min-h-9">Zones</TabsTrigger>
            <TabsTrigger value="area" className="min-h-11 sm:min-h-9">Areas</TabsTrigger>
          </TabsList>

          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
            <div className="col-span-2 [&>button]:min-h-11 [&>button]:w-full sm:col-span-1 sm:[&>button]:min-h-9 sm:[&>button]:w-auto">
              <PathaoImportButton
                hasPathaoProvider={state.hasPathaoProvider}
                importing={state.importing}
                onShowConfirm={() => state.setShowImportConfirm(true)}
              />
            </div>

            <Button variant="outline" size="sm" className="min-h-11 sm:min-h-9" onClick={state.handleCleanAll}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clean All Data
            </Button>

            <Button size="sm" className="min-h-11 sm:min-h-9" onClick={() => state.setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add {labels.title}
            </Button>

            {state.selectedLocationIds.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={state.handleBulkDelete}
                disabled={state.selectedLocationIds.length === 0}
                className="col-span-2 min-h-11 sm:col-span-1 sm:min-h-9"
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected ({state.selectedLocationIds.length})
              </Button>
            )}
          </div>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder={`Search ${labels.plural}...`}
              className="min-h-11 pl-8 sm:min-h-9"
              value={state.searchQuery}
              onChange={(e) => state.setSearchQuery(e.target.value)}
            />
          </div>

          {state.activeTab !== "city" && (
            <div className="w-full sm:w-64">
              <SearchableSelect
                value={state.selectedParent || "_all"}
                onValueChange={(value) =>
                  state.setSelectedParent(value === "_all" ? null : value)
                }
                options={[
                  {
                    value: "_all",
                    label: `All ${state.activeTab === "zone" ? "cities" : "zones"}`,
                  },
                  ...state.parentLocations.map((parent) => ({
                    value: parent.id,
                    label: `${parent.displayName ?? parent.name}${
                      parent.isActive ? "" : " (inactive)"
                    }`,
                    keywords: parent.displayName ? [parent.name] : undefined,
                  })),
                ]}
                placeholder={
                  state.loadingParents
                    ? `Loading ${state.activeTab === "zone" ? "cities" : "zones"}…`
                    : `All ${state.activeTab === "zone" ? "cities" : "zones"}`
                }
                searchPlaceholder={`Search ${state.activeTab === "zone" ? "cities" : "zones"}…`}
                emptyMessage={`No ${state.activeTab === "zone" ? "cities" : "zones"} found.`}
                ariaLabel={`Filter ${labels.plural} by ${state.activeTab === "zone" ? "city" : "zone"}`}
                triggerClassName="min-h-11 w-full sm:min-h-9"
                maxVisibleOptions={100}
                disabled={state.loadingParents}
              />
            </div>
          )}
        </div>

        {(["city", "zone", "area"] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-6">
            <LocationsTable
              locations={state.filteredLocations}
              loading={state.loading}
              type={tab}
              parentLocations={state.parentLocations}
              onDelete={(id) => state.openDeleteDialog(id)}
              onToggleActive={state.handleToggleActive}
              pagination={state.pagination}
              onPageChange={state.handlePageChange}
              onLimitChange={state.handleLimitChange}
              onEdit={state.handleEditLocation}
              selectedLocationIds={state.selectedLocationIds}
              onToggleSelectLocation={state.handleToggleSelectLocation}
              onSelectAllLocations={state.handleSelectAllLocations}
              areAnySelected={state.selectedLocationIds.length > 0}
              areAllSelected={
                state.filteredLocations.length > 0 &&
                state.selectedLocationIds.length === state.filteredLocations.length
              }
            />
          </TabsContent>
        ))}
      </Tabs>

      {/* Form Dialog */}
      <LocationFormDialog
        open={state.showAddDialog}
        onClose={state.closeDialog}
        activeTab={state.activeTab}
        editMode={state.editMode}
        formData={state.formData}
        setFormData={state.setFormData}
        isSubmitting={state.isSubmitting}
        parentLocations={state.parentLocations}
        loadingParents={state.loadingParents}
        onSubmit={state.handleSubmit}
      />

      {/* Delete Confirmation Dialogs */}
      <DeleteConfirmationDialogs
        activeTab={state.activeTab}
        isDeleteDialogOpen={state.isDeleteDialogOpen}
        onCloseDeleteDialog={state.closeDeleteDialog}
        onConfirmDelete={state.confirmDelete}
        isBulkDeleteDialogOpen={state.isBulkDeleteDialogOpen}
        onCloseBulkDeleteDialog={state.setIsBulkDeleteDialogOpen}
        selectedCount={state.selectedLocationIds.length}
        onConfirmBulkDelete={state.confirmBulkDelete}
        isCleanAllDialogOpen={state.isCleanAllDialogOpen}
        onCloseCleanAllDialog={state.setIsCleanAllDialogOpen}
        onConfirmCleanAll={state.confirmCleanAll}
      />

      {/* Pathao Import Confirmation Dialog */}
      <PathaoImportConfirmDialog
        open={state.showImportConfirm}
        onOpenChange={state.setShowImportConfirm}
        onConfirm={state.startImport}
      />
    </div>
  );
}
