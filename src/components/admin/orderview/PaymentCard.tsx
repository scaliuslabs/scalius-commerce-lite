// src/components/admin/orderview/PaymentCard.tsx
// Shows payment status, transaction history, and COD management for an order.

import React from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useToast } from "@/hooks/use-toast";
import {
  CreditCard,
  Banknote,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  Loader2,
  ChevronDown,
  ChevronUp,
  ReceiptText,
} from "lucide-react";
import type { Order } from "./types";

interface OrderPayment {
  id: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  paymentType: string;
  status: string;
  stripePaymentIntentId: string | null;
  sslcommerzTranId: string | null;
  sslcommerzValId: string | null;
  codCollectedBy: string | null;
  codCollectedAt: number | null;
  createdAt: number;
}

interface PaymentPlan {
  id: string;
  totalAmount: number;
  depositAmount: number;
  balanceDue: number;
  depositPaidAt: number | null;
  balancePaidAt: number | null;
  balanceDueDate: string | null;
  status: string;
}

interface CODTracking {
  id: string;
  deliveryAttempts: number;
  lastAttemptAt: number | null;
  codStatus: string;
  failureReason: string | null;
  collectedBy: string | null;
  collectedAmount: number | null;
  collectedAt: number | null;
  receiptUrl: string | null;
}

const PAYMENT_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ElementType }> = {
  unpaid: { label: "Unpaid", variant: "destructive", icon: AlertTriangle },
  partial: { label: "Partial", variant: "secondary", icon: Clock },
  paid: { label: "Paid", variant: "default", icon: CheckCircle2 },
  refunded: { label: "Refunded", variant: "outline", icon: RefreshCw },
  failed: { label: "Failed", variant: "destructive", icon: AlertTriangle },
};

const COD_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending: { label: "Pending", variant: "secondary" },
  collected: { label: "Collected", variant: "default" },
  failed: { label: "Failed", variant: "destructive" },
  returned: { label: "Returned", variant: "outline" },
};

const PAYMENT_METHOD_LABELS: Record<string, string> = {
  stripe: "Stripe",
  sslcommerz: "SSLCommerz",
  cod: "Cash on Delivery",
};

interface PaymentCardProps {
  order: Order;
}

export function PaymentCard({ order }: PaymentCardProps) {
  const { toast } = useToast();
  const [payments, setPayments] = React.useState<OrderPayment[]>([]);
  const [plan, setPlan] = React.useState<PaymentPlan | null>(null);
  const [codTracking, setCodTracking] = React.useState<CODTracking | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [historyExpanded, setHistoryExpanded] = React.useState(false);

  // Refund state
  const [isRefundDialogOpen, setIsRefundDialogOpen] = React.useState(false);
  const [refundAmount, setRefundAmount] = React.useState("");
  const [refundReason, setRefundReason] = React.useState("requested_by_customer");
  const [refundLoading, setRefundLoading] = React.useState(false);

  // COD modal state
  const [codAction, setCodAction] = React.useState<"collected" | "failed" | "returned" | null>(null);
  const [codLoading, setCodLoading] = React.useState(false);
  const [collectedBy, setCollectedBy] = React.useState("");
  const [collectedAmount, setCollectedAmount] = React.useState("");
  const [failReason, setFailReason] = React.useState<string>("not_home");
  const [failNotes, setFailNotes] = React.useState("");

  const grandTotal = order.totalAmount + order.shippingCharge - (order.discountAmount ?? 0);
  const isCOD = order.paymentMethod === "cod";

  const fetchPaymentData = React.useCallback(async () => {
    setLoading(true);
    try {
      const requests: Promise<Response>[] = [
        fetch(`/api/orders/${order.id}/payments`),
      ];
      if (isCOD) {
        requests.push(fetch(`/api/orders/${order.id}/cod`));
      }
      const responses = await Promise.all(requests);
      const [paymentsRes, codRes] = responses;

      if (paymentsRes.ok) {
        const data = await paymentsRes.json() as { payments: OrderPayment[]; plan: PaymentPlan | null };
        setPayments(data.payments);
        setPlan(data.plan);
      }
      if (codRes?.ok) {
        const data = await codRes.json() as { tracking: CODTracking | null };
        setCodTracking(data.tracking);
      }
    } catch {
      // silent — non-critical
    } finally {
      setLoading(false);
    }
  }, [order.id, isCOD]);

  React.useEffect(() => {
    fetchPaymentData();
  }, [fetchPaymentData]);

  async function submitCODAction() {
    if (!codAction) return;

    if (codAction === "collected") {
      if (!collectedBy.trim()) {
        toast({ title: "Error", description: "Collector name is required.", variant: "destructive" });
        return;
      }
      const amount = parseFloat(collectedAmount);
      if (isNaN(amount) || amount <= 0) {
        toast({ title: "Error", description: "Valid amount is required.", variant: "destructive" });
        return;
      }
    }

    setCodLoading(true);
    try {
      const body: Record<string, unknown> = { action: codAction };
      if (codAction === "collected") {
        body.collectedBy = collectedBy.trim();
        body.collectedAmount = parseFloat(collectedAmount);
      } else if (codAction === "failed") {
        body.reason = failReason;
        if (failNotes.trim()) body.notes = failNotes.trim();
      }

      const res = await fetch(`/api/orders/${order.id}/cod`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const err = await res.json() as { error?: string };
        throw new Error(err.error ?? "Failed");
      }

      const messages: Record<string, string> = {
        collected: "COD collection recorded. Page will reload.",
        failed: "Delivery failure recorded.",
        returned: "Order marked as returned.",
      };
      toast({ title: "Success", description: messages[codAction] });
      setCodAction(null);
      await fetchPaymentData();

      if (codAction === "collected" || codAction === "returned") {
        setTimeout(() => window.location.reload(), 1500);
      }
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to record COD action",
        variant: "destructive",
      });
    } finally {
      setCodLoading(false);
    }
  }

  async function handleIssueRefund() {
    const amount = parseFloat(refundAmount);
    if (isNaN(amount) || amount <= 0 || amount > (order.paidAmount ?? 0)) {
      toast({ title: "Error", description: "Valid refund amount up to the paid amount is required.", variant: "destructive" });
      return;
    }
    if (!refundReason.trim()) {
      toast({ title: "Error", description: "Refund reason is required.", variant: "destructive" });
      return;
    }

    setRefundLoading(true);
    try {
      const res = await fetch(`/api/orders/${order.id}/refund`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amount,
          reason: refundReason,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? "Failed to issue refund");
      }

      toast({
        title: "Refund Issued",
        description: `Successfully initiated refund of ৳${amount}.`,
      });

      setIsRefundDialogOpen(false);
      await fetchPaymentData();
      setTimeout(() => window.location.reload(), 1500);
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to issue refund",
        variant: "destructive",
      });
    } finally {
      setRefundLoading(false);
    }
  }

  const paymentStatusCfg = PAYMENT_STATUS_CONFIG[order.paymentStatus ?? "unpaid"] ?? PAYMENT_STATUS_CONFIG.unpaid;
  const PaymentStatusIcon = paymentStatusCfg.icon;

  return (
    <>
      <Card className="overflow-hidden">
        <CardHeader className="border-b border-border bg-muted/5 px-4 py-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" />
            Payment
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          {/* Payment method + status */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm">
              {isCOD ? (
                <Banknote className="h-4 w-4 text-muted-foreground" />
              ) : (
                <CreditCard className="h-4 w-4 text-muted-foreground" />
              )}
              <span className="font-medium">
                {PAYMENT_METHOD_LABELS[order.paymentMethod ?? "cod"] ?? order.paymentMethod}
              </span>
            </div>
            <Badge variant={paymentStatusCfg.variant} className="gap-1 text-xs">
              <PaymentStatusIcon className="h-3 w-3" />
              {paymentStatusCfg.label}
            </Badge>
          </div>

          {/* Amount breakdown */}
          <div className="space-y-1.5 text-sm rounded-lg bg-muted/30 p-3">
            <div className="flex justify-between text-muted-foreground">
              <span>Order total</span>
              <span>৳{order.totalAmount.toLocaleString()}</span>
            </div>
            {order.shippingCharge > 0 && (
              <div className="flex justify-between text-muted-foreground">
                <span>Shipping</span>
                <span>৳{order.shippingCharge.toLocaleString()}</span>
              </div>
            )}
            {(order.discountAmount ?? 0) > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Discount</span>
                <span>-৳{(order.discountAmount ?? 0).toLocaleString()}</span>
              </div>
            )}
            <div className="flex justify-between font-semibold border-t border-border pt-1.5 mt-1.5">
              <span>Grand total</span>
              <span>৳{grandTotal.toLocaleString()}</span>
            </div>
            {(order.paidAmount ?? 0) > 0 && (
              <div className="flex justify-between text-green-600">
                <span>Paid</span>
                <span>৳{(order.paidAmount ?? 0).toLocaleString()}</span>
              </div>
            )}
            {(order.balanceDue ?? 0) > 0 && (
              <div className="flex justify-between text-amber-600 font-medium">
                <span>Balance due</span>
                <span>৳{(order.balanceDue ?? 0).toLocaleString()}</span>
              </div>
            )}
          </div>

          {/* Payment plan */}
          {plan && (
            <div className="text-sm space-y-1 rounded-lg border border-border p-3">
              <div className="font-medium text-xs text-muted-foreground uppercase tracking-wide mb-2">Payment Plan</div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Deposit</span>
                <span className={plan.depositPaidAt ? "text-green-600" : "text-amber-600"}>
                  ৳{plan.depositAmount.toLocaleString()} {plan.depositPaidAt ? "✓" : "(pending)"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Balance</span>
                <span className={plan.balancePaidAt ? "text-green-600" : "text-amber-600"}>
                  ৳{plan.balanceDue.toLocaleString()} {plan.balancePaidAt ? "✓" : plan.balanceDueDate ? `due ${plan.balanceDueDate}` : "(pending)"}
                </span>
              </div>
            </div>
          )}

          {/* COD tracking */}
          {isCOD && (
            <div className="space-y-2">
              {codTracking && (
                <div className="text-sm space-y-1 rounded-lg bg-muted/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">COD Status</span>
                    <Badge variant={COD_STATUS_CONFIG[codTracking.codStatus]?.variant ?? "secondary"} className="text-xs">
                      {COD_STATUS_CONFIG[codTracking.codStatus]?.label ?? codTracking.codStatus}
                    </Badge>
                  </div>
                  {codTracking.deliveryAttempts > 0 && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Delivery attempts</span>
                      <span>{codTracking.deliveryAttempts}</span>
                    </div>
                  )}
                  {codTracking.collectedBy && (
                    <div className="flex justify-between text-muted-foreground">
                      <span>Collected by</span>
                      <span>{codTracking.collectedBy}</span>
                    </div>
                  )}
                  {codTracking.collectedAmount && (
                    <div className="flex justify-between text-green-600">
                      <span>Collected amount</span>
                      <span>৳{codTracking.collectedAmount.toLocaleString()}</span>
                    </div>
                  )}
                  {codTracking.failureReason && (
                    <div className="flex justify-between text-destructive">
                      <span>Failure reason</span>
                      <span>{codTracking.failureReason.replace(/_/g, " ")}</span>
                    </div>
                  )}
                </div>
              )}

              {/* COD action buttons — only when not yet collected/returned */}
              {(!codTracking || !["collected", "returned"].includes(codTracking.codStatus)) && (
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    className="flex-1"
                    onClick={() => {
                      setCollectedBy("");
                      setCollectedAmount(String(grandTotal));
                      setCodAction("collected");
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                    Mark Collected
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setFailReason("not_home");
                      setFailNotes("");
                      setCodAction("failed");
                    }}
                  >
                    <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                    Record Failure
                  </Button>
                  {codTracking && codTracking.deliveryAttempts > 0 && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setCodAction("returned")}
                    >
                      Return
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Refund action button */}
          {(order.paidAmount ?? 0) > 0 && order.paymentStatus !== "refunded" && (
            <div className="flex justify-end pt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRefundAmount(String(order.paidAmount));
                  setRefundReason("requested_by_customer");
                  setIsRefundDialogOpen(true);
                }}
              >
                <RefreshCw className="h-3.5 w-3.5 mr-2" />
                Issue Refund
              </Button>
            </div>
          )}

          {/* Transaction history toggle */}
          {!loading && payments.length > 0 && (
            <button
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground w-full"
              onClick={() => setHistoryExpanded((v) => !v)}
            >
              <ReceiptText className="h-3.5 w-3.5" />
              {historyExpanded ? "Hide" : "Show"} transaction history ({payments.length})
              {historyExpanded ? <ChevronUp className="h-3 w-3 ml-auto" /> : <ChevronDown className="h-3 w-3 ml-auto" />}
            </button>
          )}

          {historyExpanded && (
            <div className="space-y-2">
              {payments.map((p) => (
                <div key={p.id} className="text-xs rounded-lg border border-border p-2.5 space-y-1">
                  <div className="flex justify-between items-center">
                    <span className="font-medium capitalize">{p.paymentType} payment</span>
                    <Badge
                      variant={p.status === "succeeded" ? "default" : p.status === "failed" ? "destructive" : "secondary"}
                      className="text-xs"
                    >
                      {p.status}
                    </Badge>
                  </div>
                  <div className="flex justify-between text-muted-foreground">
                    <span>{PAYMENT_METHOD_LABELS[p.paymentMethod] ?? p.paymentMethod}</span>
                    <span className="font-medium text-foreground">
                      {p.currency} {p.amount.toLocaleString()}
                    </span>
                  </div>
                  {p.stripePaymentIntentId && (
                    <div className="text-muted-foreground font-mono truncate">
                      PI: {p.stripePaymentIntentId}
                    </div>
                  )}
                  {p.sslcommerzTranId && (
                    <div className="text-muted-foreground font-mono truncate">
                      Tran: {p.sslcommerzTranId}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Loading payment details…
            </div>
          )}
        </CardContent>
      </Card>

      {/* COD Collection Modal */}
      <Dialog open={codAction === "collected"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record COD Collection</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="collectedBy">Collected by</Label>
              <Input
                id="collectedBy"
                placeholder="Courier / agent name"
                value={collectedBy}
                onChange={(e) => setCollectedBy(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="collectedAmount">Amount collected (৳)</Label>
              <Input
                id="collectedAmount"
                type="number"
                value={collectedAmount}
                onChange={(e) => setCollectedAmount(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button onClick={submitCODAction} disabled={codLoading}>
              {codLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Confirm Collection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* COD Failure Modal */}
      <Dialog open={codAction === "failed"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Record Delivery Failure</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="failReason">Reason</Label>
              <Select value={failReason} onValueChange={setFailReason}>
                <SelectTrigger id="failReason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="not_home">Customer not home</SelectItem>
                  <SelectItem value="refused">Customer refused</SelectItem>
                  <SelectItem value="no_cash">No cash available</SelectItem>
                  <SelectItem value="wrong_address">Wrong address</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="failNotes">Notes (optional)</Label>
              <Input
                id="failNotes"
                placeholder="Additional details…"
                value={failNotes}
                onChange={(e) => setFailNotes(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitCODAction} disabled={codLoading}>
              {codLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Record Failure
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* COD Return Confirmation */}
      <Dialog open={codAction === "returned"} onOpenChange={(open) => !open && setCodAction(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Mark as Returned</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            This will mark the order as returned to the merchant. This action cannot be undone.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCodAction(null)}>Cancel</Button>
            <Button variant="destructive" onClick={submitCODAction} disabled={codLoading}>
              {codLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Mark Returned
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Refund Dialog */}
      <Dialog open={isRefundDialogOpen} onOpenChange={setIsRefundDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Issue Refund</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm text-muted-foreground p-3 bg-muted/50 rounded-md">
              <div className="flex justify-between">
                <span>Maximum refundable:</span>
                <span className="font-medium text-foreground">৳{(order.paidAmount ?? 0).toLocaleString()}</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="refundAmount">Refund Amount (৳)</Label>
              <Input
                id="refundAmount"
                type="number"
                step="0.01"
                min="0.01"
                max={order.paidAmount ?? 0}
                value={refundAmount}
                onChange={(e) => setRefundAmount(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="refundReason">Reason</Label>
              <Select value={refundReason} onValueChange={setRefundReason}>
                <SelectTrigger id="refundReason">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="requested_by_customer">Customer Request</SelectItem>
                  <SelectItem value="duplicate">Duplicate Order</SelectItem>
                  <SelectItem value="fraudulent">Fraudulent</SelectItem>
                  <SelectItem value="out_of_stock">Out of Stock</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsRefundDialogOpen(false)} disabled={refundLoading}>
              Cancel
            </Button>
            <Button onClick={handleIssueRefund} disabled={refundLoading}>
              {refundLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Submit Refund
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
