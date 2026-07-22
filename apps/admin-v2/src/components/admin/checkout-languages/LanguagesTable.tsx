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
import { Badge } from "~/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
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

function LanguageStatus({ language }: { language: ManagerCheckoutLanguage }) {
  return (
    <div className="flex flex-wrap gap-1">
      {language.isActive ? <Badge>Active</Badge> : null}
      {language.isDefault ? <Badge variant="outline">Default</Badge> : null}
      {!language.isActive && !language.isDefault ? <Badge variant="secondary">Inactive</Badge> : null}
    </div>
  );
}

function LanguageActions({
  language,
  showTrashed,
  isActionLoading,
  mobile = false,
  onEdit,
  onSetActive,
  onSoftDelete,
  onPermanentDelete,
  onRestore,
}: LanguageRowProps & { mobile?: boolean }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={mobile ? "h-11 w-11" : "h-7 w-7"}
          aria-label={`Actions for ${language.name}`}
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[180px]">
        {showTrashed ? (
          <>
            <DropdownMenuItem onClick={() => onRestore(language)} disabled={isActionLoading}>
              <ArchiveRestore className="mr-2 h-3.5 w-3.5" />
              Restore
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onPermanentDelete(language)}
              className="text-destructive focus:bg-destructive/10 focus:text-destructive"
              disabled={isActionLoading}
            >
              <Trash2 className="mr-2 h-3.5 w-3.5" />
              Delete permanently
            </DropdownMenuItem>
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={() => onEdit(language)} disabled={isActionLoading}>
              <Pencil className="mr-2 h-3.5 w-3.5" />
              Edit
            </DropdownMenuItem>
            {!language.isActive ? (
              <DropdownMenuItem onClick={() => onSetActive(language.id!, true)} disabled={isActionLoading}>
                <Star className="mr-2 h-3.5 w-3.5" />
                Set as active
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={() => onSetActive(language.id!, false)} disabled={isActionLoading}>
                <StarOff className="mr-2 h-3.5 w-3.5" />
                Deactivate
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onClick={() => onSoftDelete(language)}
              className="text-amber-700 focus:bg-amber-500/10 focus:text-amber-800 dark:text-amber-300 dark:focus:text-amber-200"
              disabled={isActionLoading || language.isActive}
            >
              <Archive className="mr-2 h-3.5 w-3.5" />
              Move to trash
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
        <LanguageStatus language={language} />
      </TableCell>
      <TableCell className="py-2 text-xs text-muted-foreground">
        {formatDate(language.updatedAt)}
      </TableCell>
      <TableCell className="text-right pr-3 py-2">
        <LanguageActions
          language={language}
          showTrashed={showTrashed}
          isActionLoading={isActionLoading}
          onEdit={onEdit}
          onSetActive={onSetActive}
          onSoftDelete={onSoftDelete}
          onPermanentDelete={onPermanentDelete}
          onRestore={onRestore}
        />
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
      <div className="space-y-3 p-2 md:hidden">
        <div className="flex items-center gap-2">
          <Select value={sort.field} onValueChange={(field) => onSort(field as SortField)}>
            <SelectTrigger className="h-11 flex-1" aria-label="Sort checkout languages by">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="name">Name</SelectItem>
              <SelectItem value="code">Code</SelectItem>
              <SelectItem value="isActive">Active status</SelectItem>
              <SelectItem value="isDefault">Default status</SelectItem>
              <SelectItem value="createdAt">Created</SelectItem>
              <SelectItem value="updatedAt">Last updated</SelectItem>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 shrink-0"
            aria-label={`Sort ${sort.order === "asc" ? "descending" : "ascending"}`}
            onClick={() => onSort(sort.field)}
          >
            {sort.order === "asc" ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
          </Button>
        </div>

        {isLoading ? (
          <div className="flex h-32 items-center justify-center" role="status" aria-label="Loading checkout languages">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : languages.length === 0 ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-6 text-center">
            <Languages className="h-8 w-8 text-muted-foreground/50" />
            <p className="font-medium text-muted-foreground">
              {hasActiveFilters ? "No languages match your filters." : showTrashed ? "Trash is empty." : "No checkout languages yet."}
            </p>
            {!showTrashed && !hasActiveFilters ? (
              <Button onClick={onCreateFirst} className="min-h-11">
                <Plus className="mr-1.5 h-4 w-4" /> Add checkout language
              </Button>
            ) : null}
          </div>
        ) : (
          languages.map((language) => (
            <article key={language.id} className="rounded-xl border bg-background p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 py-2">
                  <h3 className="flex min-w-0 items-center gap-2 break-words font-medium">
                    {language.isActive ? <Star className="h-4 w-4 shrink-0 fill-current text-amber-500" aria-hidden="true" /> : null}
                    {language.name}
                  </h3>
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{language.code}</p>
                </div>
                <LanguageActions
                  language={language}
                  showTrashed={showTrashed}
                  isActionLoading={isActionLoading}
                  mobile
                  onEdit={onEdit}
                  onSetActive={onSetActive}
                  onSoftDelete={onSoftDelete}
                  onPermanentDelete={onPermanentDelete}
                  onRestore={onRestore}
                />
              </div>
              <div className="mt-2 flex items-end justify-between gap-3 border-t pt-3">
                <LanguageStatus language={language} />
                <p className="shrink-0 text-xs text-muted-foreground">Updated {formatDate(language.updatedAt)}</p>
              </div>
            </article>
          ))
        )}
      </div>

      <div className="hidden md:block">
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
    </div>
  );
}
