import { Package, Box, Hash, Ruler, Palette, Scale } from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScannedProduct {
  productName: string;
  variantId: string;
  sku: string;
  barcode: string;
  stock: number;
  reserved: number;
  productImage: string | null;
  size: string | null;
  color: string | null;
  weight: number | null;
}

interface ProductCardProps {
  product: ScannedProduct;
  /** Flashes briefly after stock adjustment */
  stockDelta?: number | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ProductCard({ product, stockDelta }: ProductCardProps) {
  const available = product.stock - product.reserved;
  const isLowStock = available <= 5 && available > 0;
  const isOutOfStock = available <= 0;

  return (
    <div className="rounded-xl border border-zinc-700/50 bg-zinc-900 p-4">
      <div className="flex gap-3">
        {/* Image */}
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
          {product.productImage ? (
            <img
              src={product.productImage}
              alt={product.productName}
              className="h-full w-full object-cover"
            />
          ) : (
            <Package className="h-7 w-7 text-zinc-600" />
          )}
        </div>

        {/* Product info */}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-base font-semibold text-white">
            {product.productName}
          </h3>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-zinc-400">
            {product.sku && (
              <span className="flex items-center gap-1">
                <Hash className="h-3 w-3" />
                {product.sku}
              </span>
            )}
            {product.size && (
              <span className="flex items-center gap-1">
                <Ruler className="h-3 w-3" />
                {product.size}
              </span>
            )}
            {product.color && (
              <span className="flex items-center gap-1">
                <Palette className="h-3 w-3" />
                {product.color}
              </span>
            )}
            {product.weight != null && (
              <span className="flex items-center gap-1">
                <Scale className="h-3 w-3" />
                {product.weight}g
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Stock row */}
      <div className="mt-3 flex items-end justify-between rounded-lg bg-zinc-800/60 px-3 py-2">
        <div className="flex items-center gap-4">
          {/* On-hand */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              On Hand
            </div>
            <div className="flex items-center gap-1">
              <Box className="h-4 w-4 text-zinc-400" />
              <span
                className={`text-xl font-bold tabular-nums ${
                  isOutOfStock
                    ? "text-red-400"
                    : isLowStock
                      ? "text-amber-400"
                      : "text-white"
                }`}
              >
                {product.stock}
              </span>
              {/* Delta flash */}
              {stockDelta != null && stockDelta !== 0 && (
                <span
                  className={`ml-1 animate-pulse text-sm font-semibold ${
                    stockDelta > 0 ? "text-emerald-400" : "text-red-400"
                  }`}
                >
                  {stockDelta > 0 ? "+" : ""}
                  {stockDelta}
                </span>
              )}
            </div>
          </div>

          {/* Reserved */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Reserved
            </div>
            <span className="text-lg font-semibold tabular-nums text-zinc-300">
              {product.reserved}
            </span>
          </div>

          {/* Available */}
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500">
              Available
            </div>
            <span
              className={`text-lg font-semibold tabular-nums ${
                isOutOfStock
                  ? "text-red-400"
                  : isLowStock
                    ? "text-amber-400"
                    : "text-emerald-400"
              }`}
            >
              {available}
            </span>
          </div>
        </div>

        {/* Status badge */}
        {isOutOfStock && (
          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-400">
            Out of Stock
          </span>
        )}
        {isLowStock && !isOutOfStock && (
          <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-400">
            Low Stock
          </span>
        )}
      </div>

      {/* Barcode */}
      <div className="mt-2 text-center text-[10px] font-mono text-zinc-600">
        {product.barcode}
      </div>
    </div>
  );
}
