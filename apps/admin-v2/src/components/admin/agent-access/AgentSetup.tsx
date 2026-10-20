import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { aiAccessMessages } from "~/i18n/settings-ai-access";
import { toast } from "~/lib/toast";

import { getAgentSetupOrigin } from "./api";

/** The one command that connects Claude Code, Codex or Cursor to this store. */
export function agentSetupCommand(origin: string): string {
  return `npx scalius@latest init --server ${origin}`;
}

/** The remote MCP address for clients that cannot run a CLI (they sign in with OAuth). */
export function agentRemoteAddress(origin: string): string {
  return `${origin}/api/v1/mcp/dashboard`;
}

function CopyLine({ value, label, copiedMessage }: { value: string; label: string; copiedMessage: string }) {
  const t = useMessages(aiAccessMessages);
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      toast.success(copiedMessage);
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  return (
    <div className="flex gap-2">
      <Input
        readOnly
        dir="ltr"
        value={value}
        aria-label={label}
        className="min-w-0 flex-1"
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button type="button" variant="outline" aria-label={t("copyNamed", { name: label })} onClick={() => void copy()}>
        {copied ? t("copied") : t("copy")}
      </Button>
    </div>
  );
}

/**
 * "Connect an agent": the exact setup command for this store, with a copy
 * button, and the remote address for clients without a terminal. The origin is
 * a Platform setting (never an env value); while it is unset the card points
 * to the setting instead.
 */
export function AgentSetup() {
  const t = useMessages(aiAccessMessages);
  const { data: origin, isPending, isError } = useQuery({
    queryKey: ["agent-access", "setup-origin"],
    queryFn: getAgentSetupOrigin,
  });
  // A failed read says nothing about the setting, so the block stays out of the way.
  if (isPending || isError) return null;
  return (
    <section className="space-y-2" aria-labelledby="agent-setup-title">
      <h3 id="agent-setup-title" className="text-heading-sm">{t("setupTitle")}</h3>
      {origin ? (
        <>
          <p className="text-body text-muted-foreground">{t("setupHelp")}</p>
          <CopyLine value={agentSetupCommand(origin)} label={t("setupCommandLabel")} copiedMessage={t("commandCopied")} />
          <p className="pt-2 text-body text-muted-foreground">{t("setupRemote")}</p>
          <CopyLine value={agentRemoteAddress(origin)} label={t("setupRemoteLabel")} copiedMessage={t("addressCopied")} />
        </>
      ) : (
        <p className="text-body text-muted-foreground">
          {t("setupNoOrigin")}{" "}
          <Link to="/admin/settings/store" hash="webAddresses" className="text-link hover:underline">
            {t("setupNoOriginAction")}
          </Link>
        </p>
      )}
    </section>
  );
}
