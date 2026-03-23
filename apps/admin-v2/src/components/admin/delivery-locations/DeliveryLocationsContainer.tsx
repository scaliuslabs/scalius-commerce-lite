import { Plus, Search, Trash2 } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
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

  return (
    <div className="space-y-6">
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
        <div className="flex items-center justify-between">
          <TabsList>
            <TabsTrigger value="city">Cities</TabsTrigger>
            <TabsTrigger value="zone">Zones</TabsTrigger>
            <TabsTrigger value="area">Areas</TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <PathaoImportButton
              hasPathaoProvider={state.hasPathaoProvider}
              importing={state.importing}
              onShowConfirm={() => state.setShowImportConfirm(true)}
            />

            <Button variant="outline" size="sm" onClick={state.handleCleanAll}>
              <Trash2 className="mr-2 h-4 w-4" />
              Clean All Data
            </Button>

            <Button size="sm" onClick={() => state.setShowAddDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add {state.activeTab.charAt(0).toUpperCase() + state.activeTab.slice(1)}
            </Button>

            {state.selectedLocationIds.length > 0 && (
              <Button
                variant="destructive"
                size="sm"
                onClick={state.handleBulkDelete}
                disabled={state.selectedLocationIds.length === 0}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete Selected ({state.selectedLocationIds.length})
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-4">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder={`Search ${state.activeTab}s...`}
              className="pl-8"
              value={state.searchQuery}
              onChange={(e) => state.setSearchQuery(e.target.value)}
            />
          </div>

          {state.activeTab !== "city" && (
            <div className="w-64">
              <Select
                value={state.selectedParent || "_all"}
                onValueChange={(value) =>
                  state.setSelectedParent(value === "_all" ? null : value)
                }
              >
                <SelectTrigger className="bg-background border-border text-foreground">
                  <SelectValue
                    placeholder={`Filter by ${state.activeTab === "zone" ? "city" : "zone"}`}
                  />
                </SelectTrigger>
                <SelectContent className="bg-card border-border text-foreground">
                  <SelectItem value="_all" className="text-foreground">
                    All {state.activeTab === "zone" ? "Cities" : "Zones"}
                  </SelectItem>
                  {state.parentLocations.map((parent) => (
                    <SelectItem
                      key={parent.id}
                      value={parent.id}
                      className="text-foreground"
                    >
                      {parent.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
