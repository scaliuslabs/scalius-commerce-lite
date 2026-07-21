import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Loader2, ExternalLink, RotateCcw } from "lucide-react";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import {
  getStorefrontUrl,
  updateStorefrontUrl,
} from "~/lib/api-functions/storefront-url";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { queryKeys } from "~/lib/query-keys";
import { SettingsLoadFailure } from "./settings/SettingsLoadFailure";
import { HomepagePresentationBuilder } from "./settings/HomepagePresentationBuilder";
import { UnsavedChangesGuard } from "./shared/UnsavedChangesGuard";
import { useCallback, useState } from "react";

interface StorefrontUrlValues {
  storefrontUrl: string;
}

const fetchUrl = async (): Promise<StorefrontUrlValues> => {
  const data = await getStorefrontUrl();
  return {
    storefrontUrl: data.storefrontUrl ?? "",
  };
};

const saveUrl = async (values: StorefrontUrlValues) => {
  const storefrontUrl = normalizeStorefrontOrigin(values.storefrontUrl);
  if (!storefrontUrl) {
    throw new Error("Enter a valid public store origin before saving.");
  }
  await updateStorefrontUrl({
    data: { storefrontUrl },
  });
};

interface StorefrontUrlBuilderProps {
  initialUrl?: string;
}

export function StorefrontUrlBuilder({
  initialUrl = "",
}: StorefrontUrlBuilderProps) {
  const [homepageDraftState, setHomepageDraftState] = useState({
    isDirty: false,
    isSubmitting: false,
  });
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
    useSettingsForm<StorefrontUrlValues>({
      queryKey: queryKeys.settings.storefrontUrl(),
      fetchFn: fetchUrl,
      saveFn: saveUrl,
      defaultValues: { storefrontUrl: initialUrl },
      invalidateQueryKeys: [queryKeys.settings.seoDiscoveryLiveProbe()],
      successMessage: "Storefront URL saved successfully.",
      errorMessage: "Failed to save storefront URL.",
    });

  const storefrontOrigin = normalizeStorefrontOrigin(values.storefrontUrl);
  const validationMessage = values.storefrontUrl.trim() && !storefrontOrigin
    ? "Use an HTTPS origin without a path, query, credentials, or fragment."
    : !values.storefrontUrl.trim()
      ? "Enter the public store origin."
      : null;
  const hasUnsavedChanges = isDirty || homepageDraftState.isDirty;
  const everyDirtyFormIsSubmitting = hasUnsavedChanges &&
    (!isDirty || isSaving) &&
    (!homepageDraftState.isDirty || homepageDraftState.isSubmitting);
  const handleHomepageDraftStateChange = useCallback(
    (next: { isDirty: boolean; isSubmitting: boolean }) => {
      setHomepageDraftState(next);
    },
    [],
  );

  const testUrl = () => {
    if (!storefrontOrigin) return;
    window.open(storefrontOrigin, "_blank", "noopener,noreferrer");
  };

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
        title="Store URL unavailable"
        error={loadError}
        fallback="The current storefront URL could not be loaded."
        onRetry={refetch}
      />
    );
  }

  return (
    <div className="space-y-8">
      <UnsavedChangesGuard
        isDirty={hasUnsavedChanges}
        isSubmitting={everyDirtyFormIsSubmitting}
      />
      <div className="max-w-3xl space-y-4">
        <div className="space-y-2">
          <Label htmlFor="storefront-url">Store URL</Label>
          <div className="flex gap-2">
            <Input
              id="storefront-url"
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={values.storefrontUrl}
              onChange={(e) => setValue("storefrontUrl", e.target.value)}
              placeholder="https://shop.example.com"
              aria-invalid={Boolean(validationMessage)}
              aria-describedby="storefront-url-help storefront-url-error"
              className="min-h-11 flex-1 md:min-h-9"
            />
            <Button
              type="button"
              className="h-11 w-11 md:h-10 md:w-10"
              variant="outline"
              size="icon"
              onClick={testUrl}
              disabled={!storefrontOrigin}
              title="Open storefront"
              aria-label="Open storefront"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          </div>
          {validationMessage ? (
            <p id="storefront-url-error" role="alert" className="text-xs text-destructive">
              {validationMessage}
            </p>
          ) : null}
          <p id="storefront-url-help" className="text-xs text-muted-foreground">
            Used for storefront links, previews, discovery files, and cache refreshes.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2 border-t pt-4 sm:flex sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="min-h-11 md:min-h-10"
            onClick={reset}
            disabled={!isDirty || isSaving || !isLoaded}
          >
            <RotateCcw className="h-4 w-4" />
            Reset
          </Button>
          <Button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={isSaving || !isLoaded || !isDirty || Boolean(validationMessage)}
            className="min-h-11 min-w-[120px] md:min-h-10"
          >
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save URL"
            )}
          </Button>
        </div>
      </div>

      <HomepagePresentationBuilder
        onDraftStateChange={handleHomepageDraftStateChange}
      />
    </div>
  );
}
