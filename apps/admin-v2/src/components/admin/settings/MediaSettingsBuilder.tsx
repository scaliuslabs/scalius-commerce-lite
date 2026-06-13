import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { getMediaSettings, updateMediaSettings } from "@/lib/api-functions/settings";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";

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
  const { values, setValue, isLoading, isSaving, handleSubmit } =
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

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between gap-4 rounded-md border border-border p-4">
        <div className="space-y-1">
          <Label htmlFor="image-optimization-enabled">Image optimization</Label>
          <p className="text-xs text-muted-foreground">
            Rewrite eligible media through Cloudflare Image Resizing.
          </p>
        </div>
        <Switch
          id="image-optimization-enabled"
          checked={values.enabled}
          onCheckedChange={(checked) => setValue("enabled", checked)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="canonical-cdn-url">Canonical CDN host</Label>
        <Input
          id="canonical-cdn-url"
          value={values.canonicalCdnUrl}
          onChange={(event) => setValue("canonicalCdnUrl", event.target.value)}
          placeholder="cdn.example.com"
        />
        <p className="text-xs text-muted-foreground">
          Leave empty to use the Worker CDN_DOMAIN_URL binding. This host is
          used for bare media keys and canonical optimized image URLs.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="allowed-image-hosts">Additional resizable hosts</Label>
        <Textarea
          id="allowed-image-hosts"
          value={values.allowedImageHostsText}
          onChange={(event) =>
            setValue("allowedImageHostsText", event.target.value)
          }
          placeholder={"media.example.com\ncdn.example.com"}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          One host per line. These hosts are allowed to serve their own
          /cdn-cgi/image URLs when they support Cloudflare Image Resizing.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="canonical-host-aliases">Canonical host aliases</Label>
        <Textarea
          id="canonical-host-aliases"
          value={values.canonicalHostAliasesText}
          onChange={(event) =>
            setValue("canonicalHostAliasesText", event.target.value)
          }
          placeholder={"old-media.example.com\nr2-public.example.com"}
          rows={4}
        />
        <p className="text-xs text-muted-foreground">
          One host per line. If a stored media URL uses one of these hosts, the
          storefront keeps the object path but emits it from the canonical CDN
          host.
        </p>
      </div>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={handleSubmit}
          disabled={isSaving}
          className="min-w-[140px]"
        >
          {isSaving ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Media Settings"
          )}
        </Button>
      </div>
    </div>
  );
}
