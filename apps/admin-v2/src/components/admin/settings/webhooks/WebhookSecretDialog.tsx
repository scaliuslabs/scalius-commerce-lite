import { useState } from "react";
import { toast } from "~/lib/toast";
import { WEBHOOK_EVENT_ID_HEADER, WEBHOOK_SIGNATURE_HEADER } from "@scalius/shared/events";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { useMessages } from "~/i18n";
import { webhooksMessages } from "~/i18n/settings-webhooks";

/**
 * Shows a new (or rotated) signing secret once, with how receivers check a
 * delivery. It closes only through "I've saved it"; closing drops the secret
 * from the page.
 */
export function WebhookSecretDialog({
  secret,
  rotated,
  onClose,
}: {
  secret: string | null;
  rotated: boolean;
  onClose: () => void;
}) {
  const t = useMessages(webhooksMessages);
  const [copied, setCopied] = useState(false);
  const close = () => {
    setCopied(false);
    onClose();
  };
  async function copy() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast.success(t("secretCopied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogContent
        className="sm:max-w-xl"
        showCloseButton={false}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t(rotated ? "newSecretTitle" : "secretTitle")}</DialogTitle>
          <DialogDescription>{t("secretDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input
            readOnly
            value={secret ?? ""}
            aria-label={t("secretLabel")}
            spellCheck={false}
            // eslint-disable-next-line shadcn/no-restyle -- the secret is a standalone mono value
            className="min-w-0 flex-1 font-mono"
            onFocus={(event) => event.currentTarget.select()}
          />
          <Button type="button" variant="outline" onClick={() => void copy()}>
            {copied ? t("copied") : t("copy")}
          </Button>
        </div>
        <section className="space-y-2">
          <h3 className="text-heading-sm">{t("verifyTitle")}</h3>
          <dl className="space-y-2 text-body">
            <div className="space-y-0.5">
              <dt><code>{WEBHOOK_SIGNATURE_HEADER}: t=…,v1=…</code></dt>
              <dd className="text-muted-foreground">{t("signatureHelp")}</dd>
            </div>
            <div className="space-y-0.5">
              <dt><code>{WEBHOOK_EVENT_ID_HEADER}</code></dt>
              <dd className="text-muted-foreground">{t("eventIdHelp")}</dd>
            </div>
          </dl>
        </section>
        <DialogFooter>
          <Button type="button" onClick={close}>
            {t("secretSaved")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
