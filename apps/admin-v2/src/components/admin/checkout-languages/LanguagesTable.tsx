import React from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "~/components/ui/dropdown-menu";
import {
  MoreHorizontal,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Pencil,
  Plus,
  Loader2,
  Languages,
  Star,
  Globe,
  Archive,
  ArchiveRestore,
  StarOff,
} from "lucide-react";
import { formatDateShort as formatDate } from "@scalius/shared/timestamps";
import type { ManagerCheckoutLanguage, SortField, SortOrder } from "./hooks/useLanguages";

function getSortIcon(sort: { field: SortField; order: SortOrder }, field: SortField) {
  if (sort.field !== field)
    return <ArrowUpDown className="ml-1 h-3.5 w-3.5 inline" />;
  return sort.order === "asc" ? (
    <ArrowUp className="ml-1 h-3.5 w-3.5 inline" />
  ) : (
    <ArrowDown className="ml-1 h-3.5 w-3.5 inline" />
  );
}

interface LanguageRowProps {
  language: ManagerCheckoutLanguage;
  showTrashed: boolean;
  isActionLoading: boolean;
  onEdit: (language: ManagerCheckoutLanguage) => void;
  onSetActive: (id: string, isActive: boolean) => void;
  onSoftDelete: (language: ManagerCheckoutLanguage) => void;
  onPermanentDelete: (language: ManagerCheckoutLanguage) => void;
  onRestore: (language: ManagerCheckoutLanguage) => void;
}

const LanguageRow = React.memo(function LanguageRow({
  language,
  showTrashed,
  isActionLoading,
  onEdit,
  onSetActive,
  onSoftDelete,
  onPermanentDelete,
  onRestore,
}: LanguageRowProps) {
  return (
    <TableRow className="hover:bg-muted/50 transition-colors">
      <TableCell className="py-2 text-sm font-medium text-foreground">
        <div className="flex items-center gap-2">
          {language.isActive && (
            <Star className="h-3.5 w-3.5 text-yellow-500 fill-current" />
          )}
          {language.isDefault && (
            <Globe className="h-3.5 w-3.5 text-blue-500" />
          )}
          {language.name}
        </div>
      </TableCell>
      <TableCell className="py-2 text-xs font-mono">
        {language.code}
      </TableCell>
      <TableCell className="py-2 text-xs">
        <div className="flex flex-col gap-1">
          {language.isActive && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">
              Active
            </span>
          )}
          {language.isDefault && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-700">
              Default
            </span>
          )}
          {!language.isActive && !language.isDefault && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-700">
              Inactive
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {formatDate(language.updatedAt)}
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7">
              <MoreHorizontal className="h-3.5 w-3.5" />
              <span className="sr-only">Actions</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            {showTrashed ? (
              <>
                <DropdownMenuItem
                  onClick={() => onRestore(language)}
                  disabled={isActionLoading}
                >
                  <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
                  Restore
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onPermanentDelete(language)}
                  className="text-destructive focus:text-destructive focus:bg-destructive/10"
                  disabled={isActionLoading}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Delete Permanently
                </DropdownMenuItem>
              </>
            ) : (
              <>
                <DropdownMenuItem
                  onClick={() => onEdit(language)}
                  disabled={isActionLoading}
                >
                  <Pencil className="mr-2 h-3.5 w-3.5" />
                  Edit
                </DropdownMenuItem>
                {!language.isActive && (
                  <DropdownMenuItem
                    onClick={() => onSetActive(language.id!, true)}
                    disabled={isActionLoading || language.isActive}
                  >
                    <Star className="mr-2 h-3.5 w-3.5" />
                    Set as Active
                  </DropdownMenuItem>
                )}
                {language.isActive && (
                  <DropdownMenuItem
                    onClick={() => onSetActive(language.id!, false)}
                    disabled={isActionLoading || !language.isActive}
                  >
                    <StarOff className="mr-2 h-3.5 w-3.5" />
                    Deactivate
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => onSoftDelete(language)}
                  className="text-amber-600 focus:text-amber-700 focus:bg-amber-50"
                  disabled={isActionLoading || language.isActive}
                >
                  <Archive className="mr-2 h-3.5 w-3.5" />
                  Move to Trash
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
});

interface LanguagesTableProps {
  languages: ManagerCheckoutLanguage[];
  isLoading: boolean;
  isActionLoading: boolean;
  showTrashed: boolean;
  hasActiveFilters: boolean;
  sort: { field: SortField; order: SortOrder };
  onSort: (field: SortField) => void;
  onEdit: (language: ManagerCheckoutLanguage) => void;
  onSetActive: (id: string, isActive: boolean) => void;
  onSoftDelete: (language: ManagerCheckoutLanguage) => void;
  onPermanentDelete: (language: ManagerCheckoutLanguage) => void;
  onRestore: (language: ManagerCheckoutLanguage) => void;
  onCreateFirst: () => void;
}

export function LanguagesTable({
  languages,
  isLoading,
  isActionLoading,
  showTrashed,
  hasActiveFilters,
  sort,
  onSort,
  onEdit,
  onSetActive,
  onSoftDelete,
  onPermanentDelete,
  onRestore,
  onCreateFirst,
}: LanguagesTableProps) {
  return (
    <div className="border-t">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("name")}
              >
                Name {getSortIcon(sort, "name")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("code")}
              >
                Code {getSortIcon(sort, "code")}
              </Button>
            </TableHead>
            <TableHead className="py-2 text-xs">Status</TableHead>
            <TableHead className="py-2 text-xs">
              <Button
                variant="ghost"
                className="px-0 hover:bg-transparent -ml-1 h-7 text-xs"
                onClick={() => onSort("updatedAt")}
              >
                Last Updated {getSortIcon(sort, "updatedAt")}
              </Button>
            </TableHead>
            <TableHead className="w-[70px] text-right pr-3 py-2 text-xs">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={5} className="h-32 text-center">
                <Loader2 className="h-6 w-6 animate-spin mx-auto text-primary" />
              </TableCell>
            </TableRow>
          )}
          {!isLoading && languages.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="h-32 text-center">
                <div className="flex flex-col items-center justify-center gap-1.5">
                  <Languages className="h-8 w-8 text-muted-foreground/50" />
                  <p className="text-base font-medium text-muted-foreground">
                    {hasActiveFilters
                      ? "No languages match criteria."
                      : showTrashed
                        ? "Trash is empty."
                        : "No checkout languages yet."}
                  </p>
                  {!showTrashed && !hasActiveFilters && (
                    <Button
                      size="sm"
                      onClick={onCreateFirst}
                      className="mt-1 h-7 text-xs"
                    >
                      <Plus className="h-3.5 w-3.5 mr-1" />
                      Add First Language
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            languages.map((language) => (
              <LanguageRow
                key={language.id}
                language={language}
                showTrashed={showTrashed}
                isActionLoading={isActionLoading}
                onEdit={onEdit}
                onSetActive={onSetActive}
                onSoftDelete={onSoftDelete}
                onPermanentDelete={onPermanentDelete}
                onRestore={onRestore}
              />
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
