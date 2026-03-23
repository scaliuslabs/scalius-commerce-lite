import React from "react";
import {
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import { Tag, Trash2, Plus, ShoppingBag, Image as ImageIcon } from "lucide-react";
import { StatCard } from "../shared/StatCard";
import { navigateTo } from "~/lib/client/navigate";

interface CategoryHeaderProps {
  showTrashed: boolean;
  total: number;
  stats?: {
    totalCategories: number;
    categoriesWithImages: number;
    totalProducts: number;
  };
  displayStats: {
    totalCategories: number;
    categoriesWithImages: number;
    totalProducts: number;
  };
  onToggleTrash: () => void;
}

export const CategoryHeader = React.memo(function CategoryHeader({
  showTrashed,
  total,
  stats,
  displayStats,
  onToggleTrash,
}: CategoryHeaderProps) {
  return (
    <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base font-semibold tracking-tight">
            {showTrashed ? "Trash" : "Categories"}
          </CardTitle>
          <CardDescription className="mt-0 text-sm text-muted-foreground/80">
            {showTrashed
              ? "View and manage deleted categories."
              : `Manage your product categories. ${total} total categories.`}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onToggleTrash}
            className="h-7 text-sm text-muted-foreground/80 hover:text-foreground font-medium"
          >
            {showTrashed ? (
              <>
                <Tag className="h-3.5 w-3.5 mr-1" /> View Categories
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
              className="h-7 text-sm font-medium"
              onClick={() => void navigateTo("/admin/categories/new")}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Category
            </Button>
          )}
        </div>
      </div>

      {stats && !showTrashed && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          <StatCard
            title="Total Categories"
            value={displayStats.totalCategories}
            icon={Tag}
            iconBgColor="bg-blue-100 dark:bg-blue-900/30"
            iconTextColor="text-blue-600 dark:text-blue-400"
          />
          <StatCard
            title="Products"
            value={displayStats.totalProducts}
            icon={ShoppingBag}
            iconBgColor="bg-purple-100 dark:bg-purple-900/30"
            iconTextColor="text-purple-600 dark:text-purple-400"
          />
          <StatCard
            title="With Images"
            value={displayStats.categoriesWithImages}
            icon={ImageIcon}
            iconBgColor="bg-orange-100 dark:bg-orange-900/30"
            iconTextColor="text-orange-600 dark:text-orange-400"
          />
        </div>
      )}
    </CardHeader>
  );
});
