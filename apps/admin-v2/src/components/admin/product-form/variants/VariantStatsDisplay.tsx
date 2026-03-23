interface VariantStats {
  total: number;
  totalStock: number;
  averagePrice: number;
  lowStockCount: number;
  outOfStockCount: number;
}

interface VariantStatsDisplayProps {
  stats: VariantStats;
  symbol: string;
}

export function VariantStatsDisplay({ stats, symbol }: VariantStatsDisplayProps) {
  if (stats.total === 0) return null;

  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground bg-muted/50 px-2 py-1 rounded-md border border-border/50 whitespace-nowrap overflow-x-auto hide-scrollbar hidden sm:flex">
      <span>
        Stock: <span className="font-medium text-foreground">{stats.totalStock}</span>
      </span>
      <span className="text-border">|</span>
      <span>
        Avg: <span className="font-medium text-foreground">{symbol}{stats.averagePrice.toFixed(2)}</span>
      </span>

      {(stats.lowStockCount > 0 || stats.outOfStockCount > 0) && (
        <span className="text-border">|</span>
      )}

      {stats.lowStockCount > 0 && (
        <span className="font-medium text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 px-1 py-0 rounded">
          {stats.lowStockCount} Low
        </span>
      )}
      {stats.outOfStockCount > 0 && (
        <span className="font-medium text-red-700 bg-red-50 dark:bg-red-900/30 dark:text-red-400 px-1 py-0 rounded border border-red-200 dark:border-red-900">
          {stats.outOfStockCount} Out
        </span>
      )}
    </div>
  );
}
