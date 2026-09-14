import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { ExternalLink } from "lucide-react";
import { normalizeStorefrontOrigin } from "@scalius/shared/storefront-url";
import {
  getStorefrontUrl,
  updateStorefrontUrl,
} from "~/lib/api-functions/storefront-url";
import {
  ContextualSaveBar,
  FieldError,
  InlineHelp,
  SettingsSection,
  SkeletonPage,
} from "~/components/admin/shell";
import { useSettingsForm } from "~/hooks/use-settings-form";
import { queryKeys } from "~/lib/query-keys";
import { SettingsLoadFailure } from "./settings/SettingsLoadFailure";
import { HomepagePresentationBuilder } from "./settings/HomepagePresentationBuilder";
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
  // The homepage section owns its own draft and its own save. Its dirty state
  // still keeps the page guarded so homepage work cannot be lost by navigating.
  const hasUnsavedChanges = isDirty || isSaving ||
    homepageDraftState.isDirty || homepageDraftState.isSubmitting;
  // A failed or pending read must never be saved back as an editable default.
  const saveBlocked = !isLoaded || !isDirty || Boolean(validationMessage);
  const saveDisabledReason = !isLoaded
    ? "Reload the storefront URL before saving."
    : validationMessage
      ? "Fix the highlighted fields before saving."
      : !isDirty
        ? "The homepage section below saves from its own controls."
        : undefined;
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
      <SkeletonPage
        showHeader={false}
        sections={1}
        rowsPerSection={1}
        label="Loading storefront URL"
      />
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
    <div>
      <ContextualSaveBar
        isDirty={hasUnsavedChanges}
        saving={isSaving}
        saveDisabled={saveBlocked}
        saveDisabledReason={saveDisabledReason}
        saveLabel="Save URL"
        allowSamePathNavigation
        // The settings section picker is sticky on narrow widths.
        stickyClassName="sticky top-15 z-30 lg:top-0"
        onDiscard={reset}
        onSave={() => void handleSubmit()}
      />

      <div className="space-y-8">
        <SettingsSection
          title="Storefront URL"
          description="The public origin every link, preview, discovery file, and cache refresh is built from."
        >
          <div className="space-y-2">
            <Label htmlFor="storefront-url">Storefront URL</Label>
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
                className="min-h-11 flex-1 sm:min-h-9"
              />
              <Button
                type="button"
                className="h-11 w-11 shrink-0 sm:h-9 sm:w-9"
                variant="outline"
                size="icon"
                onClick={testUrl}
                disabled={!storefrontOrigin}
                title="Open storefront"
                aria-label="Open storefront"
              >
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
            <FieldError id="storefront-url-error">{validationMessage}</FieldError>
            <InlineHelp id="storefront-url-help">
              Used for links, previews, discovery, and cache refreshes.
            </InlineHelp>
          </div>
        </SettingsSection>

        <HomepagePresentationBuilder
          onDraftStateChange={handleHomepageDraftStateChange}
        />
      </div>
    </div>
  );
}
