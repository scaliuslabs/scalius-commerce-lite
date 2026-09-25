// The Claim card in a warranty-claim thread's context rail (Wave B §5.3, §9.1):
// the item, the policy revision the buyer bought, the warranty dates, the
// claim status and the status actions (with an optional reply to the buyer).
// Claims are records: resolving one never moves money, stock or the order;
// a replacement or refund is done from the order page, linked here.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { CONVERSATION_LIMITS } from "@scalius/shared/conversation";
import {
  WARRANTY_CLAIM_RESOLUTIONS,
  WARRANTY_CLAIM_STATUSES,
  type WarrantyClaimResolution,
  type WarrantyClaimStatus,
} from "@scalius/shared/warranty";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { NativeSelect } from "~/components/ui/native-select";
import { Skeleton } from "~/components/ui/skeleton";
import { Textarea } from "~/components/ui/textarea";
import { useHasPermission } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { warrantyMessages } from "~/i18n/warranty";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import type { StaffThread } from "~/lib/api-query-options/inbox";
import { newRequestKey } from "../inbox-api";
import { ClaimStatusBadge } from "../../warranty/ClaimStatusBadge";
import { useUpdateWarrantyClaim, warrantyClaimQueryOptions, type WarrantyClaim } from "../../warranty/warranty-api";
import { warrantyDate, warrantySummary } from "../../warranty/warranty-format";

export function WarrantyClaimContext({ thread }: { thread: StaffThread }) {
  const t = useMessages(warrantyMessages);
  const canView = useHasPermission(PERMISSIONS.ORDERS_VIEW);
  const canEditOrders = useHasPermission(PERMISSIONS.ORDERS_EDIT);
  const canReply = useHasPermission(PERMISSIONS.CONVERSATIONS_REPLY);
  const claimId = thread.subjectId;
  const claim = useQuery({ ...warrantyClaimQueryOptions(claimId ?? ""), enabled: canView && Boolean(claimId) });
  if (!canView || !claimId || claim.isError) return null;

  return (
    <section className="flex flex-col gap-2 p-4">
      <h3 className="text-heading-sm">{t("claim")}</h3>
      {claim.data ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <ClaimStatusBadge status={claim.data.status} />
            {claim.data.resolution ? <span className="text-body text-muted-foreground">{t(`resolution.${claim.data.resolution}`)}</span> : null}
          </div>
          <ClaimFacts claim={claim.data} />
          {canEditOrders && canReply ? <ClaimStatusForm key={claim.data.version} claim={claim.data} /> : null}
        </>
      ) : (
        <div aria-busy className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      )}
    </section>
  );
}

function ClaimFacts({ claim }: { claim: WarrantyClaim }) {
  const t = useMessages(warrantyMessages);
  const product = [claim.item.productName, claim.item.variantLabel].filter(Boolean).join(" · ");
  const warranty = claim.warranty;
  return (
    <div className="flex flex-col gap-1 text-body">
      {product ? <p className="break-words font-medium">{product}</p> : null}
      <p className="break-words">{t("policyRevision", { name: claim.policy.name, revision: claim.policy.revision })}</p>
      <p className="text-muted-foreground">{warrantySummary(t, claim.policy)}</p>
      <p className="text-muted-foreground">
        {t("bought", { date: warrantyDate(warranty.startsAt) })}
        {" · "}
        {warranty.voidedAt ? t("voided") : t(warranty.active ? "expires" : "expired", { date: warrantyDate(warranty.expiresAt) })}
      </p>
      {warranty.replacementUntil && !warranty.voidedAt ? (
        <p className="text-muted-foreground">{t("replacementUntil", { date: warrantyDate(warranty.replacementUntil) })}</p>
      ) : null}
      {claim.openedBy === "staff" && !warranty.active ? <p className="text-muted-foreground">{t("goodwill")}</p> : null}
      <Link to="/admin/orders/$orderId" params={{ orderId: claim.order.id }} className="text-link hover:underline">
        {t("order", { number: claim.order.orderNumber })}
      </Link>
    </div>
  );
}

function ClaimStatusForm({ claim }: { claim: WarrantyClaim }) {
  const t = useMessages(warrantyMessages);
  const [status, setStatus] = useState<WarrantyClaimStatus>(claim.status);
  const [resolution, setResolution] = useState<WarrantyClaimResolution | "">(claim.resolution ?? "");
  const [message, setMessage] = useState("");
  const [missingResolution, setMissingResolution] = useState(false);
  const requestKey = useRef(newRequestKey());
  const update = useUpdateWarrantyClaim(claim.id);

  useEffect(() => {
    if (status !== "resolved") setMissingResolution(false);
  }, [status]);

  const dirty = status !== claim.status || (status === "resolved" && resolution !== (claim.resolution ?? "")) || message.trim() !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (update.isPending || !dirty) return;
    if (status === "resolved" && !resolution) {
      setMissingResolution(true);
      document.getElementById("warranty-claim-resolution")?.focus();
      return;
    }
    update.mutate(
      {
        version: claim.version,
        status,
        resolution: status === "resolved" ? (resolution as WarrantyClaimResolution) : null,
        message: message.trim() || null,
        requestKey: requestKey.current,
      },
      {
        onSuccess: () => {
          toast.success(t("updated"));
          setMessage("");
          requestKey.current = newRequestKey();
        },
      },
    );
  };

  const error = update.error
    ? isAdminApiConflictError(update.error) ? t("claimConflict") : getServerFnError(update.error, t("updateFailed"))
    : null;

  return (
    <form method="post" noValidate className="flex flex-col gap-3 border-t pt-3" onSubmit={submit}>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="warranty-claim-status">{t("status")}</Label>
        <NativeSelect id="warranty-claim-status" value={status} onValueChange={(value) => setStatus(value as WarrantyClaimStatus)}>
          {WARRANTY_CLAIM_STATUSES.map((value) => <option key={value} value={value}>{t(`status.${value}`)}</option>)}
        </NativeSelect>
      </div>
      {status === "resolved" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="warranty-claim-resolution">{t("resolution")}</Label>
          <NativeSelect
            id="warranty-claim-resolution"
            value={resolution}
            aria-invalid={missingResolution}
            aria-describedby={missingResolution ? "warranty-claim-resolution-error" : undefined}
            onValueChange={(value) => {
              setResolution(value as WarrantyClaimResolution);
              setMissingResolution(false);
            }}
          >
            <option value="" disabled>{t("chooseResolution")}</option>
            {WARRANTY_CLAIM_RESOLUTIONS.map((value) => <option key={value} value={value}>{t(`resolution.${value}`)}</option>)}
          </NativeSelect>
          {missingResolution ? <p id="warranty-claim-resolution-error" className="text-body text-destructive">{t("resolutionRequired")}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="warranty-claim-message">{t("reply")}</Label>
        <Textarea
          id="warranty-claim-message"
          rows={3}
          maxLength={CONVERSATION_LIMITS.bodyLength}
          value={message}
          aria-describedby="warranty-claim-message-help"
          onChange={(event) => setMessage(event.target.value)}
        />
        <p id="warranty-claim-message-help" className="text-body text-muted-foreground">{t("replyHelp")}</p>
      </div>
      <Button type="submit" size="sm" className="self-start" loading={update.isPending} disabled={!dirty}>{t("update")}</Button>
    </form>
  );
}
