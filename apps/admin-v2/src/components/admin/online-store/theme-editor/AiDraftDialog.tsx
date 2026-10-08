/**
 * Draft with AI (owner decision: AI drafts are part of the builder). The
 * merchant's words go to an AI provider an app connects (Scalius has no
 * built-in model or key); the answer arrives as ordinary unsaved sections,
 * each validated against the theme's section schemas and marked as an AI
 * draft until it is opened. Without such an app the dialog says, in plain
 * words, the two ways to get one: connect an AI agent (it drafts through
 * the store's agent operations) or install an AI app.
 *
 * The editor loads this file only when the dialog opens, and the dialog asks
 * for the store's AI providers only then: the editor pays nothing for AI it
 * does not use. A failed draft shows one message here; the editor is untouched.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Info, Sparkles } from "lucide-react";
import { getApiV1AdminSettingsThemeAiProviders, postApiV1AdminSettingsThemeAiDraft } from "@scalius/api-client/sdk";
import type { StorefrontSection } from "@scalius/shared/storefront-theme";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Label } from "~/components/ui/label";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { themeEditorMessages } from "~/i18n/theme-editor";
import { apiData } from "~/lib/api";
import { actionErrorText } from "../shared";

export type AiPage = "home" | "landing" | "product" | "collection" | "cart" | "page";

const EXAMPLES = ["aiExampleSale", "aiExampleStory", "aiExampleFaq"] as const;

const NO_PROVIDERS: ReadonlyArray<{ id: string; name: string; appName: string }> = [];

export function AiDraftDialog({ open, onOpenChange, page, locale, canConnectAgent, onDrafted }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  page: AiPage;
  /** The store language the words should be in. */
  locale: string;
  /** May this staff member connect an AI agent (Settings → Integrations)? */
  canConnectAgent: boolean;
  onDrafted: (sections: StorefrontSection[], note: string | null, rejected: number) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const query = useQuery({
    queryKey: ["theme-editor", "ai-providers"],
    queryFn: async () => (await apiData(getApiV1AdminSettingsThemeAiProviders())).items,
    enabled: open,
    staleTime: 60_000,
  });
  const providers = query.data ?? NO_PROVIDERS;
  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState(providers[0]?.id ?? "");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setPrompt("");
      setError(null);
    }
  }, [open]);
  useEffect(() => {
    if (!providers.some((provider) => provider.id === providerId)) setProviderId(providers[0]?.id ?? "");
  }, [providers, providerId]);
  const draft = async () => {
    setWorking(true);
    setError(null);
    try {
      const result = await apiData(postApiV1AdminSettingsThemeAiDraft({ body: { providerId, prompt: prompt.trim(), page, locale, limit: 3 } }));
      onDrafted(result.sections as StorefrontSection[], result.note, result.rejected);
    } catch (failure) {
      setError(actionErrorText(failure));
    } finally {
      setWorking(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-ai-draft>
        <DialogHeader>
          <DialogTitle>{t("draftWithAi")}</DialogTitle>
          <DialogDescription>{t(query.isPending ? "aiChecking" : providers.length > 0 ? "aiHelp" : "aiNoProvider")}</DialogDescription>
        </DialogHeader>
        {query.isPending ? null : providers.length > 0 ? (
          <form
            id="ai-draft-form"
            method="post"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (prompt.trim()) void draft();
            }}
          >
            {providers.length > 1 ? (
              <div className="space-y-1">
                <Label htmlFor="ai-draft-provider">{t("aiProvider")}</Label>
                <SearchableSelect
                  id="ai-draft-provider"
                  value={providerId}
                  options={providers.map((provider) => ({ value: provider.id, label: `${provider.name} · ${provider.appName}` }))}
                  onValueChange={setProviderId}
                  triggerClassName="w-full"
                />
              </div>
            ) : null}
            <div className="space-y-1">
              <Label htmlFor="ai-draft-prompt">{t("aiPrompt")}</Label>
              <Textarea id="ai-draft-prompt" rows={3} maxLength={2000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("aiPromptPlaceholder")} />
            </div>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t("aiExamples")}>
              {EXAMPLES.map((key) => (
                <Button key={key} type="button" variant="outline" size="sm" onClick={() => setPrompt(t(key))}>{t(`${key}Label`)}</Button>
              ))}
            </div>
            <Alert variant="info">
              <Info aria-hidden="true" />
              <AlertDescription>{t("aiReviewNote")}</AlertDescription>
            </Alert>
            {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
          </form>
        ) : (
          // One next step: an AI app. Merchants who already run their own AI agent get a quieter second path.
          <div className="space-y-3">
            <p className="text-body">{t("aiInstallAppHelp")}</p>
            <Button asChild><Link to="/admin/apps">{t("aiInstallAppAction")}</Link></Button>
            <p className="text-body text-muted-foreground">
              {t("aiConnectAgentHelp")}{" "}
              {canConnectAgent
                ? <Link to="/admin/settings/integrations" className="text-link hover:underline">{t("aiConnectAgentAction")}</Link>
                : t("aiAskOwner")}
            </p>
          </div>
        )}
        <DialogFooter>
          {providers.length > 0 ? <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button> : null}
          {providers.length > 0 ? (
            <Button type="submit" form="ai-draft-form" loading={working} disabled={!prompt.trim() || !providerId}>
              <Sparkles aria-hidden="true" />
              {t("aiCreate")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
