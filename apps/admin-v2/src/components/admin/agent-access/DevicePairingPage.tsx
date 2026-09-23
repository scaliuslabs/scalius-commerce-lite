import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { SettingsCard, SettingsField } from "~/components/admin/settings/SettingsPage";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";

import { AccessFields, defaultSelection } from "./AccessFields";
import {
  approveAgentDeviceAuthorization,
  denyAgentDeviceAuthorization,
  lookupAgentDeviceAuthorization,
} from "./api";
import type { AgentDeviceAuthorization, AgentGrantSelection } from "./types";

function normalizeUserCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}

/**
 * Pairs a developer tool by the code it shows. The code is typed into a
 * form and sent in the request body; it never enters the page URL.
 */
export function DevicePairingPage() {
  const t = useMessages(aiAccessMessages);
  const [userCode, setUserCode] = useState("");
  const [device, setDevice] = useState<AgentDeviceAuthorization | null>(null);
  const [selection, setSelection] = useState<AgentGrantSelection>(() => defaultSelection("cli"));
  const [decision, setDecision] = useState<"approved" | "denied" | null>(null);

  const lookup = useMutation({
    mutationFn: () => lookupAgentDeviceAuthorization(userCode),
    onSuccess: (result) => {
      setDevice(result);
      setSelection(defaultSelection("cli", result.resource));
    },
    onError: () => toast.error(t("pairNotFound")),
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      approve
        ? approveAgentDeviceAuthorization(device!.id, {
            ...selection,
            label: device?.profileName ?? device?.clientName ?? undefined,
          })
        : denyAgentDeviceAuthorization(device!.id),
    onSuccess: (result) => setDecision(result.status),
    onError: () => toast.error(t("connectFailed")),
  });

  const reset = () => {
    setUserCode("");
    setDevice(null);
    setDecision(null);
    lookup.reset();
    decide.reset();
  };

  let body;
  if (decision || (device && device.status !== "pending")) {
    body = (
      <SettingsCard
        title={decision === "approved" ? t("pairConnected") : decision ? t("pairNotConnected") : t("pairUnavailable")}
      >
        <Button type="button" variant="outline" className="w-fit" onClick={reset}>
          {decision ? t("pairAnother") : t("pairOtherCode")}
        </Button>
      </SettingsCard>
    );
  } else if (device) {
    body = (
      <SettingsCard
        title={t("pairWants", { name: device.clientName ?? t("pairUnnamed") })}
        description={device.profileName ?? undefined}
      >
        <AccessFields kind="cli" value={selection} onChange={setSelection} disabled={decide.isPending} />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" disabled={decide.isPending} onClick={reset}>
            {t("pairOtherCode")}
          </Button>
          <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
            {t("dontConnect")}
          </Button>
          <Button type="button" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
            {decide.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("connect")}
          </Button>
        </div>
      </SettingsCard>
    );
  } else {
    body = (
      <SettingsCard title={t("pairTitle")} description={t("pairDescription")}>
        <form
          method="post"
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (userCode.length === 8) lookup.mutate();
          }}
        >
          <SettingsField id="pairing-code" label={t("pairCode")} help={t("pairCodeHelp")}>
            <Input
              id="pairing-code"
              value={userCode}
              onChange={(event) => setUserCode(normalizeUserCode(event.target.value))}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
              placeholder="AB12CD34"
              aria-describedby="pairing-code-note"
              autoFocus
            />
          </SettingsField>
          <Button type="submit" className="w-full" disabled={userCode.length !== 8 || lookup.isPending}>
            {lookup.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {t("continue")}
          </Button>
        </form>
      </SettingsCard>
    );
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground sm:py-12">
      <div className="mx-auto max-w-xl">{body}</div>
    </main>
  );
}
