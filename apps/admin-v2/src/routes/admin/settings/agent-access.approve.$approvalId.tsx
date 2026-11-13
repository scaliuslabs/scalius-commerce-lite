import { useState } from "react";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { AccessPage } from "~/components/admin/agent-access";
import { ChangeApprovalSummary, ChangeApprovalTargets, changeRequesterText, closedTargetLists } from "~/components/admin/agent-access/ChangeApprovalDetails";
import { describeApproval } from "~/components/admin/agent-access/approval-describe";
import { SettingsCard } from "~/components/admin/settings/SettingsPage";
import { Button } from "~/components/ui/button";
import { useLocale, useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import {
  getApiV1AdminAgentAccessApprovalsByApprovalId,
  postApiV1AdminAgentAccessApprovalsByApprovalId,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { readAdminApiErrorCode } from "~/lib/admin-api-error";
import { OWNER_ONLY_DENIAL } from "~/lib/admin-access";
import { getFreshAdminRouteContext } from "~/lib/admin-route-context";
import { RouteErrorComponent } from "~/lib/route-error";

// A person approves one change an AI assistant or access key asked to make
// (audit R2 F3). The agent only ever has this link: the change runs once,
// after the grant's owner approves it here in a 2FA-verified session. The
// page names the connection that asks and the records the change acts on
// (product titles, SKUs, order numbers, customer names), read from the
// input the approval binds (black-box M7).

/** Approving runs inside a fresh Super Admin session (agent grants belong to Super Admins). */
export async function requireFreshChangeApprovalAuthority() {
  const context = await getFreshAdminRouteContext();
  if (!context.isSuperAdmin) throw redirect(OWNER_ONLY_DENIAL);
  return context;
}

async function loadApproval(approvalId: string) {
  try {
    return await apiData(getApiV1AdminAgentAccessApprovalsByApprovalId({ path: { approvalId } }));
  } catch {
    return null;
  }
}

export const Route = createFileRoute(
  "/admin/settings/agent-access/approve/$approvalId",
)({
  beforeLoad: requireFreshChangeApprovalAuthority,
  loader: ({ params }) => loadApproval(params.approvalId),
  head: () => ({
    meta: [
      { title: "Approve a change | Scalius Admin" },
      { name: "referrer", content: "no-referrer" },
      { name: "robots", content: "noindex,nofollow,noarchive" },
    ],
  }),
  errorComponent: RouteErrorComponent,
  component: ApprovalRoute,
});

function ApprovalRoute() {
  const { approvalId } = Route.useParams();
  const approval = Route.useLoaderData();
  const t = useMessages(aiAccessMessages);
  const locale = useLocale();
  const router = useRouter();
  const [status, setStatus] = useState<"ready" | "saving" | "approved" | "declined" | "error" | "changed">(
    approval?.status === "approved" ? "approved" : "ready",
  );
  // The long lists under Affects the person has opened: each is opened before Approve is offered.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());

  const answer = async (decision: "approve" | "decline") => {
    setStatus("saving");
    try {
      // The approval names the records as the person read them; a record changed since is refused.
      await apiData(postApiV1AdminAgentAccessApprovalsByApprovalId({
        path: { approvalId },
        body: { decision, ...(decision === "approve" && approval ? { recordsDigest: approval.recordsDigest } : {}) },
      }));
      setStatus(decision === "approve" ? "approved" : "declined");
    } catch (error) {
      if (readAdminApiErrorCode(error) === "approval_changed") {
        // Read it again: the page shows what changed, and the person decides again.
        setOpened(new Set());
        setStatus("changed");
        await router.invalidate();
        return;
      }
      setStatus("error");
    }
  };

  if (!approval) {
    return (
      <AccessPage title={t("changeTitle")}>
        <SettingsCard>
          <p role="alert" className="text-body text-muted-foreground">{t("changeUnavailable")}</p>
        </SettingsCard>
      </AccessPage>
    );
  }

  const answered = status === "approved" || status === "declined";
  const requester = changeRequesterText(t, approval.requester);
  const description = describeApproval(approval.rows, locale, approval.targets);
  // A change the page cannot put in words, or that names records it cannot name, cannot be approved
  // here (fail closed); the server refuses the same (`unreviewable`), and says so when the page did not.
  const describable = description.undescribed.length === 0 && approval.unreviewable.length === 0;
  const reasons = description.reasons.length > 0 || describable ? description.reasons : [t("changeWhyUnnamed")];
  const closed = closedTargetLists(approval.targets, opened);
  return (
    <AccessPage title={t("changeTitle")}>
      <SettingsCard>
        <ChangeApprovalSummary description={description} requester={requester} />
        <ChangeApprovalTargets
          targets={approval.targets}
          opened={opened}
          onOpen={(kind) => setOpened((current) => new Set(current).add(kind))}
        />
        {describable ? null : (
          <div role="alert" className="flex flex-col gap-1 text-body text-destructive">
            <p>{t("changeCannotApprove")}</p>
            {reasons.map((reason) => <p key={reason}>{reason}</p>)}
          </div>
        )}
        {describable && closed.length > 0 && !answered ? (
          <p role="status" className="text-body text-muted-foreground">{t("changeWhyListClosed")}</p>
        ) : null}
        {status === "error" ? (
          <p role="alert" className="text-body text-destructive">{t("changeFailed")}</p>
        ) : null}
        {status === "changed" ? (
          <p role="alert" className="text-body text-destructive">{t("changeChanged")}</p>
        ) : null}
        {status === "approved" ? (
          <p role="status" className="text-body text-muted-foreground">{t("changeApproved")}</p>
        ) : null}
        {status === "declined" ? (
          <p role="status" className="text-body text-muted-foreground">{t("changeDeclined")}</p>
        ) : null}
        {answered ? null : (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              className="w-full sm:w-fit"
              disabled={status === "saving" || !describable || closed.length > 0}
              onClick={() => void answer("approve")}
            >
              {status === "saving" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {t("changeApprove")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full sm:w-fit"
              disabled={status === "saving"}
              onClick={() => void answer("decline")}
            >
              {t("changeDecline")}
            </Button>
          </div>
        )}
      </SettingsCard>
    </AccessPage>
  );
}
