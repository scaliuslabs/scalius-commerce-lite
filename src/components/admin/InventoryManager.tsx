// src/components/admin/InventoryManager.tsx
// Admin UI for inventory management: low-stock alerts and manual stock adjustments.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, RefreshCw, PackageSearch, Loader2, Plus, Minus } from "lucide-react";

interface LowStockAlert {
  id: string;
  variantId: string;
  productId: string;
  currentQty: number;
  threshold: number;
  alertStatus: string;
  alertSentAt: number | null;
  acknowledgedAt: number | null;
  resolvedAt: number | null;
  productName: string | null;
  variantSku: string | null;
  variantSize: string | null;
  variantColor: string | null;
}

type AdjustReason = "received" | "correction" | "damage" | "theft" | "return" | "other";

const REASON_LABELS: Record<AdjustReason, string> = {
  received: "Received stock",
  correction: "Inventory correction",
  damage: "Damaged goods",
  theft: "Theft / shrinkage",
  return: "Customer return",
  other: "Other",
};

export function InventoryManager() {
  const [alerts, setAlerts] = useState<LowStockAlert[]>([]);
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [loading, setLoading] = useState(true);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);

  // Adjust stock modal state
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustVariantId, setAdjustVariantId] = useState("");
  const [adjustDelta, setAdjustDelta] = useState("");
  const [adjustReason, setAdjustReason] = useState<AdjustReason>("received");
  const [adjustNotes, setAdjustNotes] = useState("");
  const [adjustPool, setAdjustPool] = useState<"stock" | "preorderStock">("stock");
  const [adjustLoading, setAdjustLoading] = useState(false);

  const fetchAlerts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/inventory/alerts?status=${statusFilter}`);
      if (!res.ok) throw new Error("Failed to fetch alerts");
      const data = await res.json() as { alerts: LowStockAlert[] };
      setAlerts(data.alerts);
    } catch {
      toast.error("Failed to load inventory alerts");
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    fetchAlerts();
  }, [fetchAlerts]);

  async function acknowledgeAlert(variantId: string) {
    setAcknowledging(variantId);
    try {
      const res = await fetch("/api/inventory/alerts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ variantId }),
      });
      if (!res.ok) throw new Error("Failed to acknowledge");
      toast.success("Alert acknowledged");
      await fetchAlerts();
    } catch {
      toast.error("Failed to acknowledge alert");
    } finally {
      setAcknowledging(null);
    }
  }

  function openAdjustForVariant(variantId: string) {
    setAdjustVariantId(variantId);
    setAdjustDelta("");
    setAdjustReason("received");
    setAdjustNotes("");
    setAdjustPool("stock");
    setAdjustOpen(true);
  }

  async function submitAdjustment() {
    const delta = parseInt(adjustDelta, 10);
    if (isNaN(delta) || delta === 0) {
      toast.error("Enter a non-zero integer for the quantity change");
      return;
    }
    if (!adjustVariantId.trim()) {
      toast.error("Variant ID is required");
      return;
    }

    setAdjustLoading(true);
    try {
      const res = await fetch(`/api/inventory/${adjustVariantId.trim()}/adjust`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          delta,
          reason: adjustReason,
          notes: adjustNotes.trim() || undefined,
          pool: adjustPool,
        }),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed to adjust stock");
      }

      const result = await res.json() as {
        previousStock: number;
        newStock: number;
        delta: number;
      };

      toast.success(
        `Stock updated: ${result.previousStock} → ${result.newStock} (${delta > 0 ? "+" : ""}${delta})`
      );
      setAdjustOpen(false);
      await fetchAlerts();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to adjust stock");
    } finally {
      setAdjustLoading(false);
    }
  }

  function variantLabel(alert: LowStockAlert) {
    const parts = [alert.variantSku, alert.variantSize, alert.variantColor].filter(Boolean);
    return parts.length > 0 ? parts.join(" / ") : alert.variantId;
  }

  return (
    <div className="space-y-6">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as "active" | "all")}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active alerts</SelectItem>
              <SelectItem value="all">All alerts</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchAlerts} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setAdjustVariantId("");
            setAdjustDelta("");
            setAdjustReason("received");
            setAdjustNotes("");
            setAdjustPool("stock");
            setAdjustOpen(true);
          }}
        >
          <Plus className="h-4 w-4 mr-1" />
          Adjust Stock
        </Button>
      </div>

      {/* Alerts table */}
      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading alerts…
          </div>
        ) : alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
            <PackageSearch className="h-8 w-8" />
            <p className="text-sm">
              {statusFilter === "active" ? "No active low-stock alerts" : "No alerts found"}
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Product</th>
                <th className="px-4 py-3 text-left font-medium text-muted-foreground">Variant</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Stock</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Threshold</th>
                <th className="px-4 py-3 text-center font-medium text-muted-foreground">Status</th>
                <th className="px-4 py-3 text-right font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {alerts.map((alert) => (
                <tr key={alert.id} className="hover:bg-muted/10 transition-colors">
                  <td className="px-4 py-3 font-medium">
                    {alert.productName ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {variantLabel(alert)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={
                        alert.currentQty === 0
                          ? "font-semibold text-destructive"
                          : "font-semibold text-amber-600"
                      }
                    >
                      {alert.currentQty}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right text-muted-foreground">
                    {alert.threshold}
                  </td>
                  <td className="px-4 py-3 text-center">
                    {alert.alertStatus === "active" ? (
                      <Badge variant="destructive" className="text-xs">
                        <AlertTriangle className="h-3 w-3 mr-1" />
                        Active
                      </Badge>
                    ) : alert.alertStatus === "acknowledged" ? (
                      <Badge variant="secondary" className="text-xs">
                        Acknowledged
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-xs">
                        <CheckCircle2 className="h-3 w-3 mr-1" />
                        Resolved
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openAdjustForVariant(alert.variantId)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Adjust
                      </Button>
                      {alert.alertStatus === "active" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => acknowledgeAlert(alert.variantId)}
                          disabled={acknowledging === alert.variantId}
                        >
                          {acknowledging === alert.variantId ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3 mr-1" />
                          )}
                          Acknowledge
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Adjust Stock Modal */}
      <Dialog open={adjustOpen} onOpenChange={setAdjustOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adjust Stock</DialogTitle>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="variantId">Variant ID</Label>
              <Input
                id="variantId"
                placeholder="e.g. abc123…"
                value={adjustVariantId}
                onChange={(e) => setAdjustVariantId(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Find the variant ID in the product edit page.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="delta">
                  Quantity change
                </Label>
                <div className="relative">
                  <Input
                    id="delta"
                    type="number"
                    placeholder="e.g. +10 or -5"
                    value={adjustDelta}
                    onChange={(e) => setAdjustDelta(e.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Positive = add, negative = remove
                </p>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pool">Stock pool</Label>
                <Select
                  value={adjustPool}
                  onValueChange={(v) => setAdjustPool(v as "stock" | "preorderStock")}
                >
                  <SelectTrigger id="pool">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="stock">Regular stock</SelectItem>
                    <SelectItem value="preorderStock">Pre-order stock</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reason">Reason</Label>
              <Select
                value={adjustReason}
                onValueChange={(v) => setAdjustReason(v as AdjustReason)}
              >
                <SelectTrigger id="reason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(REASON_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Input
                id="notes"
                placeholder="Additional details…"
                value={adjustNotes}
                onChange={(e) => setAdjustNotes(e.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submitAdjustment} disabled={adjustLoading}>
              {adjustLoading ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : parseInt(adjustDelta) < 0 ? (
                <Minus className="h-4 w-4 mr-2" />
              ) : (
                <Plus className="h-4 w-4 mr-2" />
              )}
              Apply Adjustment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
