// The order's warranties (Wave B §5.3, §9.1): per line the policy the buyer
// bought, its expiry and replacement window, and the latest claim with a way
// to it; staff can open a claim for the buyer (goodwill after expiry).
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import type { WarrantyClaimStatus, WarrantyDurationUnit, WarrantyProvider } from "@scalius/shared/warranty";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { getServerFnError } from "~/lib/api-helpers";
import { newRequestKey } from "../inbox/inbox-api";
import { useOpenWarrantyClaim } from "../warranty/warranty-api";
import { warrantyDate, warrantySummary } from "../warranty/warranty-format";
import { ClaimStatusBadge } from "../warranty/ClaimStatusBadge";
import type { Order } from "./types";

export interface WarrantyLine {
  warrantyId: string;
  productName: string | null;
  variantLabel: string | null;
  policyName: string;
  provider: WarrantyProvider;
  durationValue: number;
  durationUnit: WarrantyDurationUnit;
  replacementDays: number | null;
  quantity: number;
  expiresAt: string;
  replacementUntil: string | null;
  voided: boolean;
  openClaimId: string | null;
  claim: { id: string; conversationId: string; status: WarrantyClaimStatus } | null;
}

function readWarranty(value: unknown): Omit<WarrantyLine, "productName" | "variantLabel"> | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.warrantyId !== "string" || typeof row.policyName !== "string" || typeof row.expiresAt !== "string") return null;
  const claim = row.claim && typeof row.claim === "object" ? row.claim as Record<string, unknown> : null;
  return {
    warrantyId: row.warrantyId,
    policyName: row.policyName,
    provider: row.provider === "store" ? "store" : "brand",
    durationValue: typeof row.durationValue === "number" ? row.durationValue : 0,
    durationUnit: (row.durationUnit as WarrantyDurationUnit) ?? "months",
    replacementDays: typeof row.replacementDays === "number" ? row.replacementDays : null,
    quantity: typeof row.quantity === "number" ? row.quantity : 1,
    expiresAt: row.expiresAt,
    replacementUntil: typeof row.replacementUntil === "string" ? row.replacementUntil : null,
    voided: row.voided === true,
    openClaimId: typeof row.openClaimId === "string" ? row.openClaimId : null,
    claim: claim && typeof claim.id === "string" && typeof claim.conversationId === "string"
      ? { id: claim.id, conversationId: claim.conversationId, status: claim.status as WarrantyClaimStatus }
      : null,
  };
}

/** Every warranty record on the order's lines (`extras.warranty`), in line order. */
export function orderWarranties(order: Pick<Order, "items">): WarrantyLine[] {
  return order.items.flatMap((item) => {
    const rows = item.extras?.warranty;
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((value) => {
      const row = readWarranty(value);
      return row ? [{ ...row, productName: item.productName, variantLabel: item.variantLabel }] : [];
    });
  });
}

export function WarrantyLinesCard({ order }: { order: Order }) {
  const t = useMessages(warrantyMessages);
  const canEditOrders = useHasPermission(PERMISSIONS.ORDERS_EDIT);
  const canReply = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const canOpen = canEditOrders && canReply;
  const [opening, setOpening] = useState<WarrantyLine | null>(null);
  const lines = orderWarranties(order);
  if (lines.length === 0) return null;
  const now = Date.now();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("lines")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="divide-y">
          {lines.map((line) => {
            const product = [line.productName, line.variantLabel].filter(Boolean).join(" · ");
            const expired = Date.parse(line.expiresAt) <= now;
            const replacementOpen = line.replacementUntil !== null && Date.parse(line.replacementUntil) > now;
            return (
              <li key={line.warrantyId} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                <div className="min-w-0 space-y-1">
                  {product ? <p className="break-words font-medium">{product}</p> : null}
                  <p>{line.policyName} · {warrantySummary(t, line)}</p>
                  <p className="flex flex-wrap items-center gap-2 text-muted-foreground">
                    {line.voided ? (
                      <Badge variant="outline">{t("voided")}</Badge>
                    ) : (
                      <span>{t(expired ? "expired" : "expires", { date: warrantyDate(line.expiresAt) })}</span>
                    )}
                    {!line.voided && replacementOpen ? (
                      <span>· {t("replacementUntil", { date: warrantyDate(line.replacementUntil!) })}</span>
                    ) : null}
                    {line.claim ? <ClaimStatusBadge status={line.claim.status} /> : null}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {line.claim ? (
                    <Button asChild variant="outline" size="sm">
                      <Link to="/admin/inbox/$conversationId" params={{ conversationId: line.claim.conversationId }}>{t("viewClaim")}</Link>
                    </Button>
                  ) : null}
                  {canOpen && !line.voided && !line.openClaimId ? (
                    <Button type="button" variant="outline" size="sm" onClick={() => setOpening(line)}>{t("openClaim")}</Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
      <OpenClaimDialog orderId={order.id} line={opening} onClose={() => setOpening(null)} />
    </Card>
  );
}

function OpenClaimDialog({ orderId, line, onClose }: { orderId: string; line: WarrantyLine | null; onClose: () => void }) {
  const t = useMessages(warrantyMessages);
  const navigate = useNavigate();
  const [description, setDescription] = useState("");
  const [error, setError] = useState(false);
  const requestKey = useRef("");
  const open = useOpenWarrantyClaim(orderId);
  const reset = open.reset;
  const isOpen = line !== null;

  useEffect(() => {
    if (!isOpen) return;
    setDescription("");
    setError(false);
    requestKey.current = newRequestKey();
    reset();
  }, [isOpen, reset]);

  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty: description.trim() !== "", busy: open.isPending, onClose });
  const expired = line ? Date.parse(line.expiresAt) <= Date.now() : false;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!line || open.isPending) return;
    const text = description.trim();
    if (!text) {
      setError(true);
      document.getElementById("warranty-claim-description")?.focus();
      return;
    }
    open.mutate(
      { warrantyId: line.warrantyId, description: text, requestKey: requestKey.current },
      {
        onSuccess: (claim) => {
          toast.success(t("claimOpened"));
          onClose();
          void navigate({ to: "/admin/inbox/$conversationId", params: { conversationId: claim.conversationId } });
        },
      },
    );
  };

  return (
    <>
      <Dialog open={isOpen} onOpenChange={(next) => (next ? undefined : requestClose())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("openClaimTitle")}</DialogTitle>
            <DialogDescription>{t("openClaimHelp")}</DialogDescription>
          </DialogHeader>
          <form id="warranty-claim-open" method="post" noValidate className="space-y-4" onSubmit={submit}>
            {open.error ? <Alert variant="destructive"><AlertDescription>{getServerFnError(open.error, t("claimFailed"))}</AlertDescription></Alert> : null}
            {expired ? <Alert><AlertDescription>{t("openClaimExpired")}</AlertDescription></Alert> : null}
            <div className="space-y-1.5">
              <Label htmlFor="warranty-claim-description">{t("description")}</Label>
              <Textarea
                id="warranty-claim-description"
                rows={4}
                maxLength={CONVERSATION_LIMITS.bodyLength}
                value={description}
                aria-invalid={error}
                aria-describedby={error ? "warranty-claim-description-error" : undefined}
                onChange={(event) => {
                  setDescription(event.target.value);
                  setError(false);
                }}
              />
              {error ? <p id="warranty-claim-description-error" className="text-body text-destructive">{t("descriptionRequired")}</p> : null}
            </div>
          </form>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={open.isPending} onClick={requestClose}>{t("cancel")}</Button>
            <Button type="submit" form="warranty-claim-open" loading={open.isPending}>{t("openClaim")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}
