import {
  ContextualSaveBar,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
  StatusBadge,
} from "@/components/admin/shell";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { getMediaSettings, updateMediaSettings } from "@/lib/api-functions/settings";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import { SettingsLoadFailure } from "./SettingsLoadFailure";

interface MediaSettingsValues {
  enabled: boolean;
  canonicalCdnUrl: string;
  allowedImageHostsText: string;
  canonicalHostAliasesText: string;
}

function toLines(value: unknown): string {
  return Array.isArray(value)
    ? value
        .map((item) => String(item))
        .filter(Boolean)
        .join("\n")
    : "";
}

function fromLines(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((item) =>
      item
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/$/, "")
        .toLowerCase(),
    )
    .filter(Boolean);
}

const fetchMedia = async (): Promise<MediaSettingsValues> => {
  const data = (await getMediaSettings()) as Record<string, unknown>;
  return {
    enabled: data.enabled !== false,
    canonicalCdnUrl: (data.canonicalCdnUrl as string) || "",
    allowedImageHostsText: toLines(data.allowedImageHosts),
    canonicalHostAliasesText: toLines(data.canonicalHostAliases),
  };
};

const saveMedia = async (values: MediaSettingsValues) => {
  await updateMediaSettings({
    data: {
      enabled: values.enabled,
      canonicalCdnUrl: values.canonicalCdnUrl.trim(),
      allowedImageHosts: fromLines(values.allowedImageHostsText),
      canonicalHostAliases: fromLines(values.canonicalHostAliasesText),
    },
  });
};

export default function MediaSettingsBuilder() {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    values,
    setValue,
    isLoading,
    isLoaded,
    isLoadError,
    loadError,
    isSaving,
    isDirty,
    reset,
    handleSubmit,
    refetch,
  } =
    useSettingsForm<MediaSettingsValues>({
      queryKey: queryKeys.settings.media(),
      fetchFn: fetchMedia,
      saveFn: saveMedia,
      defaultValues: {
        enabled: true,
        canonicalCdnUrl: "",
        allowedImageHostsText: "",
        canonicalHostAliasesText: "",
      },
      successMessage: "Media settings saved successfully.",
      errorMessage: "Failed to save media settings.",
    });

  const configuredHostCount =
    fromLines(values.allowedImageHostsText).length +
    fromLines(values.canonicalHostAliasesText).length;

  if (isLoading) {
    return (
      <SkeletonPage
        showHeader={false}
        sections={2}
        rowsPerSection={4}
        label="Loading media settings"
      />
    );
  }

  if (isLoadError) {
    return (
      <SettingsLoadFailure
        title="Media delivery settings unavailable"
        error={loadError}
        fallback="The current image delivery and host policy could not be loaded."
        onRetry={refetch}
      />
    );
  }

  return (
    <div className="max-w-5xl">
      <ContextualSaveBar
        isDirty={isDirty || isSaving}
        saving={isSaving}
        saveDisabled={!isDirty || !isLoaded}
        saveDisabledReason="Reload the media settings before saving."
        saveLabel="Save changes"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={reset}
        onSave={handleSubmit}
      />

      <div className="space-y-6">
        <SettingsSection
          title="Image delivery"
          description="Resizes product images through Cloudflare before buyers download them."
        >
          <div className="space-y-4">
            <div className="flex min-h-11 items-center justify-between gap-4 rounded-md border border-border px-3 py-2">
              <Label htmlFor="image-optimization-enabled">Image optimization</Label>
              <Switch
                id="image-optimization-enabled"
                checked={values.enabled}
                aria-describedby="image-optimization-help"
                onCheckedChange={(checked) => setValue("enabled", checked)}
              />
            </div>
            <InlineHelp id="image-optimization-help">
              Turn this off to serve every image at its original size.
            </InlineHelp>

            <div className="space-y-1.5">
              <Label htmlFor="canonical-cdn-url">Delivery host</Label>
              <Input
                id="canonical-cdn-url"
                value={values.canonicalCdnUrl}
                onChange={(event) => setValue("canonicalCdnUrl", event.target.value)}
                placeholder="cdn.example.com"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                aria-describedby="canonical-cdn-url-help"
                className="min-h-11 sm:min-h-9"
              />
              <InlineHelp id="canonical-cdn-url-help">
                Leave blank to use the deployed CDN host.
              </InlineHelp>
            </div>
          </div>
        </SettingsSection>

        <SettingsSection
          title="Host rules"
          description="Needed only while images still live on a host you moved away from."
          contentClassName="p-0 sm:p-0"
        >
          <details
            className="group"
            open={advancedOpen}
            onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          >
            <summary
              aria-label={`Advanced host rules, ${configuredHostCount === 0 ? "none configured" : `${configuredHostCount} configured`}`}
              className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium sm:px-6 [&::-webkit-details-marker]:hidden"
            >
              <span>Advanced host rules</span>
              <StatusBadge
                tone={configuredHostCount === 0 ? "neutral" : "info"}
                dot={false}
                className="ml-auto"
              >
                {configuredHostCount === 0
                  ? "Optional"
                  : `${configuredHostCount} host${configuredHostCount === 1 ? "" : "s"}`}
              </StatusBadge>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-4 border-t border-border px-4 py-4 sm:px-6">
              <div className="space-y-1.5">
                <Label htmlFor="allowed-image-hosts">Resizable hosts</Label>
                <Textarea
                  id="allowed-image-hosts"
                  value={values.allowedImageHostsText}
                  onChange={(event) =>
                    setValue("allowedImageHostsText", event.target.value)
                  }
                  placeholder={"media.example.com\ncdn.example.com"}
                  rows={4}
                  aria-describedby="allowed-image-hosts-help"
                />
                <InlineHelp id="allowed-image-hosts-help">
                  Images on these hosts are resized by Cloudflare, one host per line.
                </InlineHelp>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="canonical-host-aliases">Previous host aliases</Label>
                <Textarea
                  id="canonical-host-aliases"
                  value={values.canonicalHostAliasesText}
                  onChange={(event) =>
                    setValue("canonicalHostAliasesText", event.target.value)
                  }
                  placeholder={"old-media.example.com\nr2-public.example.com"}
                  rows={4}
                  aria-describedby="canonical-host-aliases-help"
                />
                <InlineHelp id="canonical-host-aliases-help">
                  Existing URLs from these hosts keep their path and use the delivery host.
                </InlineHelp>
              </div>
            </div>
          </details>
        </SettingsSection>
      </div>
    </div>
  );
}
