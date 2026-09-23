import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsCard, SettingsCardLoading, SettingsField } from "~/components/admin/settings/SettingsPage";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

import { AccessFields, AccessPage, defaultSelection } from "./AccessFields";
import {
  approveAgentAuthorizationRequest,
  denyAgentAuthorizationRequest,
  getAgentAuthorizationRequest,
} from "./api";
import { navigateOAuthDecisionCompletion } from "./oauth-completion";
import type { AgentGrantSelection } from "./types";

function redirectSite(value: string): string | null {
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * An AI assistant asks to connect. The route guarantees a fresh Super Admin
 * session; the decision redirects only to the trusted API completion URL.
 */
export function AuthorizationApprovalPage({
  requestId,
  trustedApiOrigin,
}: {
  requestId: string;
  trustedApiOrigin: string;
}) {
  const t = useMessages(aiAccessMessages);
  const requestQuery = useQuery({
    queryKey: ["agent-access", "authorization-request", requestId],
    queryFn: () => getAgentAuthorizationRequest(requestId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const request = requestQuery.data;
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState<AgentGrantSelection>(() => defaultSelection("oauth"));
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);

  useEffect(() => {
    if (!request) return;
    setLabel(request.clientName ?? "");
    setSelection(defaultSelection("oauth", request.resource, request.requestedPermissions));
  }, [request]);

  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      approve
        ? approveAgentAuthorizationRequest(requestId, {
            ...selection,
            ...(label.trim() ? { label: label.trim() } : {}),
          })
        : denyAgentAuthorizationRequest(requestId),
    onSuccess: (result) => {
      if (!navigateOAuthDecisionCompletion(result, trustedApiOrigin)) {
        toast.error(t("finishFailed"));
        void requestQuery.refetch();
        return;
      }
      setDecision(result.status);
    },
    onError: () => {
      toast.error(t("connectFailed"));
      void requestQuery.refetch();
    },
  });

  const clientName = request?.clientName ?? t("approveUnnamed");
  if (requestQuery.isPending) {
    return (
      <AccessPage title={t("approveTitle", { name: t("approveUnnamed") })}>
        <SettingsCardLoading />
      </AccessPage>
    );
  }
  if (decision || requestQuery.isError || !request || request.status !== "pending") {
    const message = decision
      ? t(decision === "approved" ? "connected" : "notConnected", { name: clientName })
      : t("requestUnavailable");
    return (
      <AccessPage title={t("approveTitle", { name: clientName })}>
        <SettingsCard title={message}>
          <Button asChild variant="outline" className="w-fit">
            <Link to="/admin/settings/apps">{t("backToApps")}</Link>
          </Button>
        </SettingsCard>
      </AccessPage>
    );
  }

  const site = redirectSite(request.redirectUri);
  return (
    <AccessPage title={t("approveTitle", { name: clientName })}>
      <SettingsCard title={clientName} description={site ? t("returnsTo", { site }) : undefined}>
        <SettingsField id="ai-approve-name" label={t("name")}>
          <Input
            id="ai-approve-name"
            value={label}
            maxLength={80}
            autoComplete="off"
            disabled={decide.isPending}
            onChange={(event) => setLabel(event.target.value)}
          />
        </SettingsField>
        <AccessFields kind="oauth" value={selection} onChange={setSelection} disabled={decide.isPending} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            {t("dontConnect")}
          </Button>
          <Button type="button" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            {decide.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("connect")}
          </Button>
        </div>
      </SettingsCard>
    </AccessPage>
  );
}
