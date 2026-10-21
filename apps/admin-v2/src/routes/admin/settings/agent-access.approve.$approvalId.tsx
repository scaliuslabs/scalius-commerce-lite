import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";

import { AccessPage } from "~/components/admin/agent-access";
import { ChangeApprovalTargets, changeRequesterText } from "~/components/admin/agent-access/ChangeApprovalDetails";
import { SettingsCard } from "~/components/admin/settings/SettingsPage";
import { Button } from "~/components/ui/button";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import {
  getApiV1AdminAgentAccessApprovalsByApprovalId,
  postApiV1AdminAgentAccessApprovalsByApprovalId,
} from "@scalius/api-client/sdk";
import { apiData } from "~/lib/api";
import { ADMIN_ACCESS_DENIED_PATH } from "~/lib/admin-access";
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
  if (!context.isSuperAdmin) throw redirect({ to: ADMIN_ACCESS_DENIED_PATH, replace: true });
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
  const [status, setStatus] = useState<"ready" | "saving" | "approved" | "declined" | "error">(
    approval?.status === "approved" ? "approved" : "ready",
  );

  const answer = async (decision: "approve" | "decline") => {
    setStatus("saving");
    try {
      await apiData(postApiV1AdminAgentAccessApprovalsByApprovalId({ path: { approvalId }, body: { decision } }));
      setStatus(decision === "approve" ? "approved" : "declined");
    } catch {
      setStatus("error");
    }
  };

  if (!approval) {
    return (
      <AccessPage title={t("changeTitle")}>
        <SettingsCard title={t("changeTitle")}>
          <p role="alert" className="text-body text-muted-foreground">{t("changeUnavailable")}</p>
        </SettingsCard>
      </AccessPage>
    );
  }

  const answered = status === "approved" || status === "declined";
  const requester = changeRequesterText(t, approval.requester);
  return (
    <AccessPage title={t("changeTitle")}>
      <SettingsCard title={requester ? t("changeAsks", { requester }) : t("changeDescription")}>
        <p className="text-body font-medium break-words">{approval.summary}</p>
        <ChangeApprovalTargets targets={approval.targets} />
        {status === "error" ? (
          <p role="alert" className="text-body text-destructive">{t("changeFailed")}</p>
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
              disabled={status === "saving"}
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
