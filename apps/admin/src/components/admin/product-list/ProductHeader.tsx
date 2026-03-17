import React from "react";
import {
  CardHeader,
  CardTitle,
  CardDescription,
} from "../../ui/card";
import { Button } from "../../ui/button";
import {
  Plus,
  Package,
  Trash2,
  Eye,
  Image as ImageIcon,
  Tag,
  ShoppingBag,
} from "lucide-react";
import { StatCard } from "../shared/StatCard";
import { navigateTo } from "@/lib/client/navigate";
import type { ProductStats } from "./hooks/useProductList";

interface ProductHeaderProps {
  showTrashed: boolean;
  total: number;
  stats?: ProductStats;
  displayStats: ProductStats;
}

export const ProductHeader = React.memo(function ProductHeader({
  showTrashed,
  total,
  stats,
  displayStats,
}: ProductHeaderProps) {
  return (
    <CardHeader className="px-2 pt-2 pb-1.5 sm:px-3 sm:pt-3 sm:pb-2 border-b">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div>
          <CardTitle className="text-base font-semibold tracking-tight">
            {showTrashed ? "Trash" : "Products"}
          </CardTitle>
          <CardDescription className="mt-0 text-xs text-muted-foreground">
            {showTrashed
              ? "View and manage deleted products."
              : `Manage your product catalog. ${total} total products.`}
          </CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              void navigateTo(
                showTrashed
                  ? "/admin/products"
                  : "/admin/products?trashed=true",
              )
            }
            className="h-7 text-xs text-muted-foreground hover:text-foreground"
          >
            {showTrashed ? (
              <>
                <Package className="h-3.5 w-3.5 mr-1" /> View Active Products
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
              onClick={() => void navigateTo("/admin/products/new")}
            >
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add Product
            </Button>
          )}
        </div>
      </div>

      {stats && !showTrashed && (
        <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          <StatCard
            title="Total Products"
            value={displayStats.totalProducts}
            icon={ShoppingBag}
            iconBgColor="bg-blue-100 dark:bg-blue-900/30"
            iconTextColor="text-blue-600 dark:text-blue-400"
          />
          <StatCard
            title="Active Products"
            value={displayStats.activeProducts}
            icon={Eye}
            iconBgColor="bg-green-100 dark:bg-green-900/30"
            iconTextColor="text-green-600 dark:text-green-400"
          />
          <StatCard
            title="With Images"
            value={displayStats.productsWithImages}
            icon={ImageIcon}
            iconBgColor="bg-orange-100 dark:bg-orange-900/30"
            iconTextColor="text-orange-600 dark:text-orange-400"
          />
          <StatCard
            title="Categories"
            value={displayStats.categoriesCount}
            icon={Tag}
            iconBgColor="bg-purple-100 dark:bg-purple-900/30"
            iconTextColor="text-purple-600 dark:text-purple-400"
          />
        </div>
      )}
    </CardHeader>
  );
});
