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
    isNew?: boolean;
    onRemoveNew?: () => void;
}

export function VariantBulkEditRow({ variant, draftUpdate, onChange, isNew, onRemoveNew }: VariantBulkEditRowProps) {
    const getValue = (field: keyof NonNullable<VariantBulkEditRowProps['draftUpdate']>) => {
        const val = draftUpdate?.[field] !== undefined ? draftUpdate[field] : (variant[field as keyof ProductVariant] ?? "");
        return val === null ? "" : (val as string | number);
    };
    const trackInventory = draftUpdate?.trackInventory ?? (variant.trackInventory !== false);
    const cellClass = "px-1 py-0.5 align-middle";
    const cellInputClass = "h-8 w-full rounded-md border border-border bg-background px-2 text-xs shadow-sm outline-none transition-colors hover:border-border/80 hover:bg-muted/10 focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20 focus-visible:ring-offset-0 placeholder:text-muted-foreground/40";

    return (
        <TableRow className="bg-background hover:bg-muted/5 transition-none">
            <TableCell className={cn(cellClass, "w-9 text-center")}></TableCell>

            {/* SKU */}
            <TableCell className={cn(cellClass, "min-w-[110px]")}>
                <Input
                    className={cn(cellInputClass, "font-mono font-medium")}
                    value={getValue('sku') || ''}
                    onChange={(e) => onChange(variant.id, 'sku', e.target.value)}
                />
            </TableCell>

            {/* Option 1 */}
            <TableCell className={cn(cellClass, "min-w-[90px]")}>
                <Input
                    placeholder="—"
                    className={cellInputClass}
                    value={getValue('size') || ''}
                    onChange={(e) => onChange(variant.id, 'size', e.target.value || null)}
                />
            </TableCell>

            {/* Option 2 */}
            <TableCell className={cn(cellClass, "min-w-[90px]")}>
                <Input
                    placeholder="—"
                    className={cellInputClass}
                    value={getValue('color') || ''}
                    onChange={(e) => onChange(variant.id, 'color', e.target.value || null)}
                />
            </TableCell>

            {/* Weight */}
            <TableCell className={cn(cellClass, "min-w-[72px]")}>
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    placeholder="—"
                    className={cellInputClass}
                    value={getValue('weight') ?? ''}
                    onChange={(e) => onChange(variant.id, 'weight', e.target.value ? parseFloat(e.target.value) : null)}
                />
            </TableCell>

            {/* Price */}
            <TableCell className={cn(cellClass, "min-w-[88px]")}>
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className={cn(cellInputClass, "tabular-nums font-semibold")}
                    value={getValue('price') ?? ''}
                    onChange={(e) => onChange(variant.id, 'price', e.target.value ? parseFloat(e.target.value) : 0)}
                />
            </TableCell>

            {/* Stock Limit */}
            <TableCell className={cn(cellClass, "min-w-[110px] px-1.5")}>
                <StockLimitSegment
                    trackInventory={trackInventory}
                    ariaLabel={`Stock limit for option ${variant.sku}`}
                    onChange={(nextValue) => onChange(variant.id, 'trackInventory', nextValue)}
                />
            </TableCell>

            {/* Stock */}
            <TableCell className={cn(cellClass, "min-w-[80px]")}>
                {trackInventory ? (
                    <Input
                        type="number"
                        min="0"
                        placeholder="0"
                        className={cn(cellInputClass, "tabular-nums font-medium")}
                        value={getValue('stock') ?? ''}
                        onChange={(e) => onChange(variant.id, 'stock', e.target.value ? parseInt(e.target.value, 10) : 0)}
                    />
                ) : (
                    <div className="flex h-8 w-full items-center rounded-md border border-border/50 bg-muted/30 px-2 text-xs text-muted-foreground/40">
                        —
                    </div>
                )}
            </TableCell>

            <TableCell
                className={cn(
                    cellClass,
                    "sticky right-0 z-10 w-[44px] bg-background text-center text-xs text-muted-foreground/30",
                )}
            >
                {isNew && (
                    <button
                        type="button"
                        onClick={onRemoveNew}
                        className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted/80 text-muted-foreground transition-colors mx-auto"
                        aria-label="Remove new row"
                    >
                        <svg width="12" height="12" viewBox="0 0 15 15" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M11.7816 4.03157C12.0062 3.80702 12.0062 3.44295 11.7816 3.2184C11.5571 2.99385 11.193 2.99385 10.9685 3.2184L7.50005 6.68682L4.03164 3.2184C3.80708 2.99385 3.44301 2.99385 3.21846 3.2184C2.99391 3.44295 2.99391 3.80702 3.21846 4.03157L6.68688 7.49999L3.21846 10.9684C2.99391 11.193 2.99391 11.5571 3.21846 11.7816C3.44301 12.0061 3.80708 12.0061 4.03164 11.7816L7.50005 8.31316L10.9685 11.7816C11.193 12.0061 11.5571 12.0061 11.7816 11.7816C12.0062 11.5571 12.0062 11.193 11.7816 10.9684L8.31322 7.49999L11.7816 4.03157Z" fill="currentColor" fillRule="evenodd" clipRule="evenodd"></path></svg>
                    </button>
                )}
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
            className="grid h-8 grid-cols-2 overflow-hidden rounded-md border border-border bg-muted/30 p-0.5 text-[10px] shadow-sm"
            role="group"
            aria-label={ariaLabel}
        >
            <button
                type="button"
                aria-label="Track stock"
                aria-pressed={trackInventory}
                title="Track stock"
                className={cn(
                    "whitespace-nowrap rounded-[5px] px-1.5 font-semibold text-muted-foreground/60 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
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
                    "flex items-center justify-center rounded-[5px] px-1 py-0.5 text-[9px] font-semibold leading-none text-muted-foreground/60 transition-all focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/30",
                    !trackInventory && "bg-slate-100 text-slate-600 shadow-sm dark:bg-slate-800 dark:text-slate-200",
                )}
                onClick={() => onChange(false)}
            >
                No stock limit
            </button>
        </div>
    );
}
