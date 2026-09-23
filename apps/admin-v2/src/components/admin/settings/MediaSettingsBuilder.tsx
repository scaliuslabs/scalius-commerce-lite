import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ChevronDown, Loader2, RotateCcw } from "lucide-react";
import { useState } from "react";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import { SettingsLoadFailure } from "./SettingsLoadFailure";
import { UnsavedChangesGuard } from "../shared/UnsavedChangesGuard";
import {
  getApiV1AdminSettingsMedia,
  postApiV1AdminSettingsMedia,
} from "@scalius/api-client/sdk";
import { apiData } from "@/lib/api";

interface MediaSettingsValues {
  canonicalCdnUrl: string;
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
  const data = (await apiData(getApiV1AdminSettingsMedia())) as Record<string, unknown>;
  return {
    canonicalCdnUrl: (data.canonicalCdnUrl as string) || "",
    canonicalHostAliasesText: toLines(data.canonicalHostAliases),
  };
};

const saveMedia = async (values: MediaSettingsValues) => {
  await apiData(postApiV1AdminSettingsMedia({
    body: {
      canonicalCdnUrl: values.canonicalCdnUrl.trim(),
      canonicalHostAliases: fromLines(values.canonicalHostAliasesText),
    },
  }));
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
        canonicalCdnUrl: "",
        canonicalHostAliasesText: "",
      },
      successMessage: "Media settings saved successfully.",
      errorMessage: "Failed to save media settings.",
    });

  const configuredHostCount = fromLines(values.canonicalHostAliasesText).length;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
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
    <div className="max-w-2xl space-y-5">
      <UnsavedChangesGuard isDirty={isDirty || isSaving} isSubmitting={false} allowSamePathStateNavigation />

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Image delivery</CardTitle>
          <CardDescription>
            The host that serves uploaded images and their pre-sized copies.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="canonical-cdn-url">Delivery host</Label>
            <Input
              id="canonical-cdn-url"
              value={values.canonicalCdnUrl}
              onChange={(event) => setValue("canonicalCdnUrl", event.target.value)}
              placeholder="cdn.example.com"
              className="min-h-11 sm:min-h-9"
            />
            <p className="text-xs text-muted-foreground">
              Leave blank to use the deployed CDN host.
            </p>
          </div>
        </CardContent>
      </Card>

      <details
        className="group rounded-lg border bg-card"
        open={advancedOpen}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary
          aria-label={`Advanced host rules, ${configuredHostCount === 0 ? "none configured" : `${configuredHostCount} configured`}`}
          className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden"
        >
          <span>Advanced host rules</span>
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {configuredHostCount === 0
              ? "Optional"
              : `${configuredHostCount} host${configuredHostCount === 1 ? "" : "s"}`}
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        </summary>
        <div className="space-y-4 border-t px-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="canonical-host-aliases">Previous host aliases</Label>
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
              Existing URLs from these hosts keep their path and use the delivery host.
            </p>
          </div>
        </div>
      </details>

      {isDirty ? (
        <div className="grid grid-cols-2 gap-2 border-t border-border pt-4 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="outline"
            onClick={reset}
            disabled={isSaving}
            className="min-h-11 sm:min-h-9"
          >
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isSaving || !isLoaded}
            className="min-h-11 min-w-[140px] sm:min-h-9"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save changes"
            )}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
