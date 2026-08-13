import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  Loader2,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
} from "lucide-react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { getServerFnError } from "~/lib/api-helpers";

import {
  approveAgentDeviceAuthorization,
  denyAgentDeviceAuthorization,
  lookupAgentDeviceAuthorization,
} from "./api";
import {
  defaultGrantSelection,
  GrantSelectionFields,
} from "./GrantSelectionFields";
import type {
  AgentDeviceAuthorization,
  AgentGrantSelection,
} from "./types";

function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

interface DevicePairingPageProps {
  availablePermissions: string[];
}

export function DevicePairingPage({
  availablePermissions,
}: DevicePairingPageProps) {
  const [userCode, setUserCode] = useState("");
  const [device, setDevice] = useState<AgentDeviceAuthorization | null>(null);
  const [selection, setSelection] = useState<AgentGrantSelection>(() =>
    defaultGrantSelection("dashboard", "read", 30),
  );
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);

  const lookupMutation = useMutation({
    mutationFn: () => lookupAgentDeviceAuthorization(userCode),
    onSuccess: (result) => {
      setDevice(result);
      setSelection(defaultGrantSelection(result.resource, "read", 30));
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "Pairing code was not found"));
    },
  });

  const approveMutation = useMutation({
    mutationFn: () =>
      approveAgentDeviceAuthorization(device!.id, {
        ...selection,
        label: device?.profileName ?? device?.clientName ?? undefined,
      }),
    onSuccess: () => {
      setDecision("approved");
      toast.success("CLI connection approved");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "CLI connection could not be approved"));
    },
  });

  const denyMutation = useMutation({
    mutationFn: () => denyAgentDeviceAuthorization(device!.id),
    onSuccess: () => {
      setDecision("denied");
      toast.success("CLI connection denied");
    },
    onError: (error) => {
      toast.error(getServerFnError(error, "CLI connection could not be denied"));
    },
  });

  const reset = () => {
    setUserCode("");
    setDevice(null);
    setDecision(null);
    lookupMutation.reset();
    approveMutation.reset();
    denyMutation.reset();
  };

  return (
    <main className="min-h-screen bg-gray-50 px-4 py-8 text-foreground dark:bg-[#0a0a0a] sm:py-12">
      <div className="mx-auto max-w-xl">
        <div className="mb-6 flex items-center justify-center gap-2 text-sm font-semibold tracking-tight">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <TerminalSquare className="h-4 w-4" aria-hidden="true" />
          </span>
          Scalius CLI
        </div>

        <Card className="shadow-none">
          <CardHeader className="border-b p-5">
            <CardTitle className="flex items-center gap-2 text-lg">
              <KeyRound className="h-5 w-5" aria-hidden="true" />
              Connect a command-line agent
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Enter the code shown by <code>scalius auth login</code>. The code
              stays in this form and never enters the page URL.
            </p>
          </CardHeader>
          <CardContent className="space-y-5 p-5">
            {decision ? (
              <div className="py-5 text-center">
                <span
                  className={`mx-auto flex h-12 w-12 items-center justify-center rounded-xl ${
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
                <h1 className="mt-4 text-lg font-semibold">Connection {decision}</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  Return to the terminal. No CLI credential is displayed in this browser.
                </p>
                <Button type="button" variant="outline" className="mt-5" onClick={reset}>
                  Pair another CLI
                </Button>
              </div>
            ) : !device ? (
              <form
                method="post"
                className="space-y-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (userCode.length === 8) lookupMutation.mutate();
                }}
              >
                <div className="space-y-1.5">
                  <Label htmlFor="cli-pairing-code">Pairing code</Label>
                  <Input
                    id="cli-pairing-code"
                    value={userCode}
                    onChange={(event) =>
                      setUserCode(normalizeUserCode(event.currentTarget.value))
                    }
                    inputMode="text"
                    autoCapitalize="characters"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={8}
                    placeholder="AB12CD34"
                    className="h-14 text-center font-mono text-xl tracking-[0.28em] uppercase"
                    aria-describedby="cli-pairing-code-help"
                    autoFocus
                  />
                  <p id="cli-pairing-code-help" className="text-xs text-muted-foreground">
                    Eight letters and numbers. It expires ten minutes after the CLI starts login.
                  </p>
                </div>
                <Button
                  type="submit"
                  className="min-h-11 w-full"
                  disabled={userCode.length !== 8 || lookupMutation.isPending}
                >
                  {lookupMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                  )}
                  Continue
                </Button>
              </form>
            ) : device.status !== "pending" ? (
              <Alert>
                <ShieldX aria-hidden="true" />
                <AlertTitle>This pairing request is {device.status}</AlertTitle>
                <AlertDescription>
                  Start <code>scalius auth login</code> again and enter the new code.
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={reset}>
                    Enter another code
                  </Button>
                </AlertDescription>
              </Alert>
            ) : (
              <div className="space-y-5">
                <div className="rounded-lg border bg-muted/20 p-4">
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border bg-card text-muted-foreground">
                      <TerminalSquare className="h-4 w-4" aria-hidden="true" />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{device.clientName ?? "Scalius CLI"}</p>
                        <Badge variant="outline">{device.resource}</Badge>
                      </div>
                      {device.profileName ? (
                        <p className="mt-1 text-xs text-muted-foreground">
                          Profile: {device.profileName}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>

                <GrantSelectionFields
                  value={selection}
                  onChange={setSelection}
                  availablePermissions={availablePermissions}
                  resourceLocked
                  maxExpiryDays={90}
                  disabled={approveMutation.isPending || denyMutation.isPending}
                />

                <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                  <Button type="button" variant="ghost" onClick={reset}>
                    <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                    Different code
                  </Button>
                  <div className="flex flex-col-reverse gap-2 sm:flex-row">
                    <Button
                      type="button"
                      variant="outline"
                      className="min-h-11 sm:min-h-9"
                      disabled={approveMutation.isPending || denyMutation.isPending}
                      onClick={() => denyMutation.mutate()}
                    >
                      <ShieldX className="h-4 w-4" aria-hidden="true" />
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
                      Approve CLI
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
