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

    return (
        <TableRow className="hover:bg-muted/50 bg-muted/20">
            <TableCell className="pl-3 pr-1 py-1.5 align-middle"></TableCell>
            <TableCell className="p-1 min-w-[120px] align-middle">
                <Input
                    className="h-7 text-xs px-2"
                    value={getValue('sku') || ''}
                    onChange={(e) => onChange(variant.id, 'sku', e.target.value)}
                />
            </TableCell>
            <TableCell className="p-1 min-w-[70px] align-middle">
                <Input
                    className="h-7 text-xs px-2"
                    value={getValue('size') || ''}
                    onChange={(e) => onChange(variant.id, 'size', e.target.value || null)}
                />
            </TableCell>
            <TableCell className="p-1 min-w-[70px] align-middle">
                <Input
                    className="h-7 text-xs px-2"
                    value={getValue('color') || ''}
                    onChange={(e) => onChange(variant.id, 'color', e.target.value || null)}
                />
            </TableCell>
            <TableCell className="p-1 min-w-[80px] align-middle">
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className="h-7 text-xs px-2"
                    value={getValue('weight') ?? ''}
                    onChange={(e) => onChange(variant.id, 'weight', e.target.value ? parseFloat(e.target.value) : null)}
                />
            </TableCell>
            <TableCell className="p-1 min-w-[90px] align-middle">
                <Input
                    type="number"
                    min="0"
                    step="0.01"
                    className="h-7 text-xs px-2 text-emerald-600 font-medium"
                    value={getValue('price') ?? ''}
                    onChange={(e) => onChange(variant.id, 'price', e.target.value ? parseFloat(e.target.value) : 0)}
                />
            </TableCell>
            <TableCell className="p-1 min-w-[112px] align-middle">
                <select
                    value={trackInventory ? "tracked" : "unlimited"}
                    onChange={(event) => onChange(variant.id, 'trackInventory', event.target.value === "tracked")}
                    aria-label={`Stock limit for option ${variant.sku}`}
                    className={cn(
                        "h-7 w-full rounded border bg-background px-2 text-xs shadow-none outline-none focus:ring-1 focus:ring-primary",
                        trackInventory ? "text-sky-700" : "text-emerald-700",
                    )}
                >
                    <option value="tracked">Track stock</option>
                    <option value="unlimited">No stock limit</option>
                </select>
            </TableCell>
            <TableCell className="p-1 min-w-[80px] align-middle">
                {trackInventory ? (
                    <Input
                        type="number"
                        min="0"
                        className="h-7 text-xs px-2"
                        value={getValue('stock') ?? ''}
                        onChange={(e) => onChange(variant.id, 'stock', e.target.value ? parseInt(e.target.value, 10) : 0)}
                    />
                ) : (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        -
                    </div>
                )}
            </TableCell>
            <TableCell className="p-1 min-w-[80px] align-middle">
                <span className="block px-2 text-xs font-medium text-muted-foreground">
                    {trackInventory ? Math.max(0, nextStock - variant.reservedStock) : "-"}
                </span>
            </TableCell>
            <TableCell className="px-3 py-2 text-xs text-muted-foreground align-middle">
                -
            </TableCell>
            <TableCell className="px-3 py-2 text-xs text-muted-foreground align-middle whitespace-nowrap">
                <span suppressHydrationWarning>
                    {updatedAt.toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                        year: "numeric",
                    })}
                </span>
            </TableCell>
            <TableCell className="px-3 py-2 text-xs text-muted-foreground align-middle text-right">
                -
            </TableCell>
        </TableRow>
    );
}
