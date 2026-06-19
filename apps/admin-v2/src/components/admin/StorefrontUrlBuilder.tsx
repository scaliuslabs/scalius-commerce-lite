import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, ExternalLink } from "lucide-react";
import {
  getStorefrontUrl,
  updateStorefrontUrl,
} from "@/lib/api-functions/storefront-url";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";

interface StorefrontUrlValues {
  storefrontUrl: string;
}

const fetchUrl = async (): Promise<StorefrontUrlValues> => {
  const data = await getStorefrontUrl();
  return {
    storefrontUrl: data.storefrontUrl || "/",
  };
};

const saveUrl = async (values: StorefrontUrlValues) => {
  await updateStorefrontUrl({
    data: { storefrontUrl: values.storefrontUrl || "/" },
  });
};

interface StorefrontUrlBuilderProps {
  initialUrl?: string;
}

export function StorefrontUrlBuilder({
  initialUrl = "/",
}: StorefrontUrlBuilderProps) {
  const { values, setValue, isLoading, isSaving, handleSubmit } =
    useSettingsForm<StorefrontUrlValues>({
      queryKey: queryKeys.settings.storefrontUrl(),
      fetchFn: fetchUrl,
      saveFn: saveUrl,
      defaultValues: { storefrontUrl: initialUrl },
      successMessage: "Storefront URL saved successfully.",
      errorMessage: "Failed to save storefront URL.",
    });

  const testUrl = () => {
    const url =
      values.storefrontUrl?.startsWith("http") ||
      values.storefrontUrl?.startsWith("/")
        ? values.storefrontUrl
        : `/${values.storefrontUrl}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-xl">
      <div className="space-y-2">
        <Label htmlFor="storefront-url">Store URL</Label>
        <div className="flex gap-2">
          <Input
            id="storefront-url"
            value={values.storefrontUrl}
            onChange={(e) => setValue("storefrontUrl", e.target.value)}
            placeholder="/"
            className="flex-1"
          />
          {values.storefrontUrl && (
            <Button
              variant="outline"
              size="icon"
              onClick={testUrl}
              title="Test URL"
            >
              <ExternalLink className="h-4 w-4" />
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Use "/" for root, "/store" for subdirectory, or a full URL like
          "https://mystore.com" for headless setups. This powers the "View
          Store" sidebar link.
        </p>
      </div>

      <div className="flex justify-end pt-4 border-t border-border">
        <Button
          onClick={handleSubmit}
          disabled={isSaving}
          className="min-w-[120px]"
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
  );
}
