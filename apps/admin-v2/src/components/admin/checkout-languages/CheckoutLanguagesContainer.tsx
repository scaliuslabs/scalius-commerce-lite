import { useState } from "react";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "~/components/ui/card";
import { Search, Trash2, Plus, Languages, X } from "lucide-react";
import { useLanguages, type ManagerCheckoutLanguage } from "./hooks/useLanguages";
import { LanguagesTable } from "./LanguagesTable";
import { LanguageFormDialog } from "./LanguageFormDialog";
import { LanguageActionsDialog } from "./LanguageActionsDialog";

export function CheckoutLanguagesContainer() {
  const {
    languages,
    pagination,
    searchQuery,
    setSearchQuery,
    sort,
    isLoading,
    isActionLoading,
    showTrashed,
    hasActiveFilters,
    handleSearch,
    handleSort,
    toggleTrash,
    clearFilters,
    handleSetActive,
    handleFormSubmit,
    handleSoftDelete,
    handlePermanentDelete,
    handleRestore,
  } = useLanguages();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingLanguage, setEditingLanguage] = useState<ManagerCheckoutLanguage | null>(null);
  const [itemToSoftDelete, setItemToSoftDelete] = useState<ManagerCheckoutLanguage | null>(null);
  const [itemToPermanentlyDelete, setItemToPermanentlyDelete] = useState<ManagerCheckoutLanguage | null>(null);
  const [itemToRestore, setItemToRestore] = useState<ManagerCheckoutLanguage | null>(null);

  const openFormForCreate = () => {
    setEditingLanguage(null);
    setIsFormOpen(true);
  };

  const openFormForEdit = (language: ManagerCheckoutLanguage) => {
    setEditingLanguage(language);
    setIsFormOpen(true);
  };

  const onFormSubmit = async (
    formData: Partial<ManagerCheckoutLanguage>,
    editingId: string | null,
  ) => {
    const success = await handleFormSubmit(formData, editingId);
    return success;
  };

  const confirmSoftDelete = (language: ManagerCheckoutLanguage) => {
    setItemToSoftDelete(language);
  };

  const confirmPermanentDelete = (language: ManagerCheckoutLanguage) => {
    setItemToPermanentlyDelete(language);
  };

  const confirmRestore = (language: ManagerCheckoutLanguage) => {
    setItemToRestore(language);
  };

  const executeSoftDelete = async (language: ManagerCheckoutLanguage) => {
    setItemToSoftDelete(null);
    await handleSoftDelete(language);
  };

  const executePermanentDelete = async (language: ManagerCheckoutLanguage) => {
    setItemToPermanentlyDelete(null);
    await handlePermanentDelete(language);
  };

  const executeRestore = async (language: ManagerCheckoutLanguage) => {
    setItemToRestore(null);
    await handleRestore(language);
  };

  return (
    <Card className="border-none shadow-none">
      <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
          <div>
            <CardTitle className="text-base font-semibold tracking-tight">
              {showTrashed
                ? "Trashed Checkout Languages"
                : "Checkout Languages"}
            </CardTitle>
            <CardDescription className="mt-0 text-xs text-muted-foreground">
              {showTrashed
                ? "View and manage deleted checkout languages."
                : `Manage checkout form languages and field customization. ${pagination.total} total languages.`}
            </CardDescription>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={toggleTrash}
              className="h-7 text-xs text-muted-foreground hover:text-foreground"
            >
              {showTrashed ? (
                <>
                  <Languages className="h-3.5 w-3.5 mr-1" /> View Active
                </>
              ) : (
                <>
                  <Trash2 className="h-3.5 w-3.5 mr-1" /> View Trash
                </>
              )}
            </Button>
            {!showTrashed && (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={openFormForCreate}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Language
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="p-0">
        <div className="p-2 sm:p-3 space-y-2">
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
            <div className="flex flex-1 items-center w-full sm:w-auto space-x-1.5">
              <form
                onSubmit={handleSearch}
                className="flex-1 sm:flex-initial sm:max-w-xs w-full"
              >
                <div className="relative">
                  <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    type="search"
                    placeholder="Search languages..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-7 h-7 w-full text-xs"
                  />
                </div>
              </form>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-1.5 text-xs text-muted-foreground"
                  onClick={clearFilters}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Clear
                </Button>
              )}
            </div>
          </div>
        </div>

        <LanguagesTable
          languages={languages}
          isLoading={isLoading}
          isActionLoading={isActionLoading}
          showTrashed={showTrashed}
          hasActiveFilters={hasActiveFilters}
          sort={sort}
          onSort={handleSort}
          onEdit={openFormForEdit}
          onSetActive={handleSetActive}
          onSoftDelete={confirmSoftDelete}
          onPermanentDelete={confirmPermanentDelete}
          onRestore={confirmRestore}
          onCreateFirst={openFormForCreate}
        />
      </CardContent>

      <LanguageFormDialog
        isOpen={isFormOpen}
        onOpenChange={setIsFormOpen}
        editingLanguage={editingLanguage}
        isActionLoading={isActionLoading}
        onSubmit={onFormSubmit}
      />

      <LanguageActionsDialog
        itemToSoftDelete={itemToSoftDelete}
        itemToPermanentlyDelete={itemToPermanentlyDelete}
        itemToRestore={itemToRestore}
        isActionLoading={isActionLoading}
        onSoftDelete={executeSoftDelete}
        onPermanentDelete={executePermanentDelete}
        onRestore={executeRestore}
        onDismissSoftDelete={() => setItemToSoftDelete(null)}
        onDismissPermanentDelete={() => setItemToPermanentlyDelete(null)}
        onDismissRestore={() => setItemToRestore(null)}
      />
    </Card>
  );
}
