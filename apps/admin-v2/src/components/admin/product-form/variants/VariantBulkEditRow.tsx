// src/components/admin/ProductForm/variants/VariantBulkEditRow.tsx
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { TableRow, TableCell } from "@/components/ui/table";
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
            <TableCell className="p-1 min-w-[80px] align-middle">
                <div className="mb-1 flex items-center justify-between gap-2 rounded border bg-background px-2 py-1">
                    <span className="text-[10px] text-muted-foreground">Track</span>
                    <Switch
                        checked={trackInventory}
                        onCheckedChange={(checked) => onChange(variant.id, 'trackInventory', checked)}
                        aria-label={`Track stock for option ${variant.sku}`}
                    />
                </div>
                {trackInventory ? (
                    <Input
                        type="number"
                        min="0"
                        className="h-7 text-xs px-2"
                        value={getValue('stock') ?? ''}
                        onChange={(e) => onChange(variant.id, 'stock', e.target.value ? parseInt(e.target.value, 10) : 0)}
                    />
                ) : (
                    <div className="rounded border border-emerald-200 bg-emerald-50 px-2 py-1.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-200">
                        No stock limit
                    </div>
                )}
                {trackInventory && variant.reservedStock > 0 && (
                    <p className="text-[10px] text-muted-foreground px-1 mt-0.5">
                        Available: {Math.max(0, nextStock - variant.reservedStock)}
                    </p>
                )}
            </TableCell>
            <TableCell colSpan={3} className="px-3 py-2 text-[10px] text-muted-foreground align-middle italic text-right pr-3">
                Editing...
            </TableCell>
        </TableRow>
    );
}
