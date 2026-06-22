// src/components/admin/ProductForm/variants/VariantBulkEditRow.tsx
import { Input } from "@/components/ui/input";
import { TableRow, TableCell } from "@/components/ui/table";
import { cn } from "@scalius/shared/utils";
import type { ProductVariant, VariantBulkEditField, VariantBulkEditValue } from "./types";

interface VariantBulkEditRowProps {
    variant: ProductVariant;
    draftUpdate?: {
        size?: string | null;
        color?: string | null;
        weight?: number | null;
        sku?: string;
        price?: number;
        stock?: number;
        trackInventory?: boolean;
    };
    onChange: (variantId: string, field: VariantBulkEditField, value: VariantBulkEditValue) => void;
}

export function VariantBulkEditRow({ variant, draftUpdate, onChange }: VariantBulkEditRowProps) {
    const getValue = (field: keyof NonNullable<VariantBulkEditRowProps['draftUpdate']>) => {
        const val = draftUpdate?.[field] !== undefined ? draftUpdate[field] : (variant[field as keyof ProductVariant] ?? "");
        return val === null ? "" : (val as string | number);
    };
    const trackInventory = draftUpdate?.trackInventory ?? (variant.trackInventory !== false);
    const nextStock = (draftUpdate?.stock !== undefined ? draftUpdate.stock : variant.stock) ?? 0;
    const updatedAt = variant.updatedAt instanceof Date ? variant.updatedAt : new Date(variant.updatedAt);
    const cellClass = "h-10 border-r p-1 align-middle last:border-r-0";
    const cellInputClass = "h-8 rounded-[4px] border border-transparent bg-transparent px-2 text-xs shadow-none transition-colors hover:border-border hover:bg-background focus-visible:border-primary focus-visible:bg-background focus-visible:ring-2 focus-visible:ring-primary/15 focus-visible:ring-offset-0";

    return (
        <TableRow className="bg-muted/15 hover:bg-muted/25">
            <TableCell className={cn(cellClass, "w-10 pl-3 pr-1")}></TableCell>
            <TableCell className={cn(cellClass, "min-w-[140px]")}>
                <Input
                    className={cn(cellInputClass, "font-mono")}
                    value={getValue('sku') || ''}
                    onChange={(e) => onChange(variant.id, 'sku', e.target.value)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[105px]")}>
                <Input
                    className={cellInputClass}
                    value={getValue('size') || ''}
                    onChange={(e) => onChange(variant.id, 'size', e.target.value || null)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[105px]")}>
                <Input
                    className={cellInputClass}
                    value={getValue('color') || ''}
                    onChange={(e) => onChange(variant.id, 'color', e.target.value || null)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[56px]")}>
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className={cellInputClass}
                    value={getValue('weight') ?? ''}
                    onChange={(e) => onChange(variant.id, 'weight', e.target.value ? parseFloat(e.target.value) : null)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[80px]")}>
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className={cn(cellInputClass, "font-medium text-emerald-700")}
                    value={getValue('price') ?? ''}
                    onChange={(e) => onChange(variant.id, 'price', e.target.value ? parseFloat(e.target.value) : 0)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[116px]")}>
                <StockLimitSegment
                    trackInventory={trackInventory}
                    ariaLabel={`Stock limit for option ${variant.sku}`}
                    onChange={(nextValue) => onChange(variant.id, 'trackInventory', nextValue)}
                />
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[68px]")}>
                {trackInventory ? (
                    <Input
                        type="number"
                        min="0"
                        className={cellInputClass}
                        value={getValue('stock') ?? ''}
                        onChange={(e) => onChange(variant.id, 'stock', e.target.value ? parseInt(e.target.value, 10) : 0)}
                    />
                ) : (
                    <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
                        -
                    </div>
                )}
            </TableCell>
            <TableCell className={cn(cellClass, "min-w-[68px]")}>
                <span className="block px-2 text-xs font-medium text-muted-foreground">
                    {trackInventory ? Math.max(0, nextStock - variant.reservedStock) : "-"}
                </span>
            </TableCell>
            <TableCell className={cn(cellClass, "text-xs text-muted-foreground")}>
                -
            </TableCell>
            <TableCell className={cn(cellClass, "whitespace-nowrap text-xs text-muted-foreground")}>
                <span suppressHydrationWarning>
                    {updatedAt.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                    })}
                </span>
            </TableCell>
            <TableCell
                className={cn(
                    cellClass,
                    "sticky right-0 z-10 w-[72px] bg-muted/15 text-right text-xs text-muted-foreground shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.35)]",
                )}
            >
                -
            </TableCell>
        </TableRow>
    );
}

function StockLimitSegment({
    trackInventory,
    ariaLabel,
    onChange,
}: {
    trackInventory: boolean;
    ariaLabel: string;
    onChange: (trackInventory: boolean) => void;
}) {
    return (
        <div
            className="grid h-8 grid-cols-2 overflow-hidden rounded-[4px] border border-border bg-background p-0.5 text-[11px]"
            role="group"
            aria-label={ariaLabel}
        >
            <button
                type="button"
                aria-label="Track stock"
                aria-pressed={trackInventory}
                title="Track stock"
                className={cn(
                    "whitespace-nowrap rounded-[3px] px-1.5 font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
                    trackInventory && "bg-emerald-50 text-emerald-700 shadow-sm dark:bg-emerald-950/30 dark:text-emerald-300",
                )}
                onClick={() => onChange(true)}
            >
                Track
            </button>
            <button
                type="button"
                aria-label="No stock limit"
                aria-pressed={!trackInventory}
                title="No stock limit"
                className={cn(
                    "whitespace-nowrap rounded-[3px] px-1.5 font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20",
                    !trackInventory && "bg-slate-100 text-slate-700 shadow-sm dark:bg-slate-800 dark:text-slate-200",
                )}
                onClick={() => onChange(false)}
            >
                No limit
            </button>
        </div>
    );
}
