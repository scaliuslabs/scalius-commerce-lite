import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  ExternalLink,
  Loader2,
  ShieldCheck,
  ShieldX,
  Store,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Skeleton } from "~/components/ui/skeleton";
import { getServerFnError } from "~/lib/api-helpers";

import {
  approveAgentAuthorizationRequest,
  denyAgentAuthorizationRequest,
  getAgentAuthorizationRequest,
} from "./api";
import {
  defaultGrantSelection,
  GrantSelectionFields,
} from "./GrantSelectionFields";
import type { AgentGrantSelection } from "./types";
import { navigateOAuthDecisionCompletion } from "./oauth-completion";

function safeRedirectOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "Registered client callback";
  }
}

interface AuthorizationApprovalPageProps {
  requestId: string;
  availablePermissions: string[];
  trustedApiOrigin: string;
}

export function AuthorizationApprovalPage({
  requestId,
  availablePermissions,
  trustedApiOrigin,
}: AuthorizationApprovalPageProps) {
  const requestQuery = useQuery({
    queryKey: ["agent-access", "authorization-request", requestId],
    queryFn: () => getAgentAuthorizationRequest(requestId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  });
  const request = requestQuery.data;
  const [label, setLabel] = useState("");
  const [selection, setSelection] = useState<AgentGrantSelection>(() =>
    defaultGrantSelection("dashboard", "read", 30),
  );
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);

  useEffect(() => {
    if (!request) return;
    setLabel(request.clientName ?? "");
    setSelection({
      ...defaultGrantSelection(request.resource, "read", 30),
      permissions: request.requestedPermissions,
    });
  }, [request]);

  const approveMutation = useMutation({
    mutationFn: () =>
      approveAgentAuthorizationRequest(requestId, {
        ...selection,
        ...(label.trim() ? { label: label.trim() } : {}),
      }),
    onSuccess: (result) => {
      const navigated = navigateOAuthDecisionCompletion(
        result,
        trustedApiOrigin,
      );
      if (!navigated) {
        toast.error("Authorization completion is unavailable or was rejected");
        void requestQuery.refetch();
        return;
      }
      setDecision("approved");
      toast.success("Agent connection approved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connection could not be approved"));
      void requestQuery.refetch();
    },
  });

  const denyMutation = useMutation({
    mutationFn: () => denyAgentAuthorizationRequest(requestId),
    onSuccess: (result) => {
      const navigated = navigateOAuthDecisionCompletion(
        result,
        trustedApiOrigin,
      );
      if (!navigated) {
        toast.error("Authorization completion is unavailable or was rejected");
        void requestQuery.refetch();
        return;
      }
      setDecision("denied");
      toast.success("Agent connection denied");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Connection could not be denied"));
      void requestQuery.refetch();
    },
  });

  if (decision) {
    return (
      <div className="mx-auto flex min-h-[60vh] max-w-xl items-center px-3 py-8">
        <Card className="w-full shadow-none">
          <CardContent className="flex flex-col items-center p-8 text-center">
            <span
              className={`flex h-12 w-12 items-center justify-center rounded-xl ${
                decision === "approved"
                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {decision === "approved" ? (
                <CheckCircle2 className="h-6 w-6" aria-hidden="true" />
              ) : (
                <ShieldX className="h-6 w-6" aria-hidden="true" />
              )}
            </span>
            <h1 className="mt-4 text-xl font-semibold">
              Connection {decision}
            </h1>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              Return to {request?.clientName ?? "your agent"}. This browser page
              does not contain the client&apos;s access token.
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-5 min-h-11 sm:min-h-9"
              onClick={() => window.close()}
            >
              Close this tab
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 py-2 sm:py-6">
      <header>
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
          <h1 className="text-xl font-semibold tracking-tight">Approve agent connection</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Confirm the client, resource, authority, and expiry before granting access.
        </p>
      </header>

      {requestQuery.isPending ? (
        <div className="space-y-3" role="status" aria-label="Loading authorization request">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-80 w-full" />
        </div>
      ) : requestQuery.error || !request ? (
        <Alert variant="destructive">
          <AlertCircle aria-hidden="true" />
          <AlertTitle>Authorization request is unavailable</AlertTitle>
          <AlertDescription>
            It may be invalid or expired. Start the connection again from the MCP client.
          </AlertDescription>
        </Alert>
      ) : request.status !== "pending" ? (
        <Alert>
          <AlertCircle aria-hidden="true" />
          <AlertTitle>This request is {request.status}</AlertTitle>
          <AlertDescription>
            Start a new connection from the MCP client to make another decision.
          </AlertDescription>
        </Alert>
      ) : (
        <>
          <Card className="shadow-none">
            <CardHeader className="border-b p-4">
              <CardTitle className="text-sm">Client requesting access</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-start">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl border bg-muted/35 text-muted-foreground">
                <Bot className="h-5 w-5" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-semibold">{request.clientName ?? "Unnamed MCP client"}</h2>
                  <Badge variant="outline" className="gap-1">
                    {request.resource === "dashboard" ? (
                      <Bot className="h-3 w-3" aria-hidden="true" />
                    ) : (
                      <Store className="h-3 w-3" aria-hidden="true" />
                    )}
                    {request.resource}
                  </Badge>
                </div>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                  Returns to {safeRedirectOrigin(request.redirectUri)}
                </p>
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
                  Client ID: {request.clientId}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Request expires {new Intl.DateTimeFormat("en-BD", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(request.expiresAt))}
                </p>
                {request.requestedPermissions.length > 0 ? (
                  <div className="mt-3">
                    <p className="text-xs font-medium">Client-requested permissions</p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {request.requestedPermissions.map((permission) => (
                        <Badge
                          key={permission}
                          variant="secondary"
                          className="font-mono text-[10px]"
                        >
                          {permission}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>

          <Card className="shadow-none">
            <CardContent className="space-y-4 p-4 sm:p-5">
              <div className="space-y-1.5">
                <Label htmlFor="oauth-connection-label">Connection name</Label>
                <Input
                  id="oauth-connection-label"
                  value={label}
                  onChange={(event) => setLabel(event.currentTarget.value)}
                  maxLength={80}
                  autoComplete="off"
                  placeholder="Codex on office Mac"
                />
              </div>
              <GrantSelectionFields
                value={selection}
                onChange={setSelection}
                availablePermissions={availablePermissions}
                resourceLocked
                maxExpiryDays={30}
                disabled={approveMutation.isPending || denyMutation.isPending}
              />
            </CardContent>
          </Card>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="min-h-11 sm:min-h-9"
              disabled={approveMutation.isPending || denyMutation.isPending}
              onClick={() => denyMutation.mutate()}
            >
              {denyMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldX className="h-4 w-4" aria-hidden="true" />
              )}
              Deny
            </Button>
            <Button
              type="button"
              className="min-h-11 sm:min-h-9"
              disabled={
                approveMutation.isPending ||
                denyMutation.isPending ||
                (selection.preset === "custom" && selection.permissions.length === 0)
              }
              onClick={() => approveMutation.mutate()}
            >
              {approveMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              Approve connection
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
