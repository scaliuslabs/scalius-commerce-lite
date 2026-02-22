import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2, ExternalLink } from "lucide-react";

interface StorefrontUrlBuilderProps {
  initialUrl?: string;
}

export function StorefrontUrlBuilder({
  initialUrl = "/",
}: StorefrontUrlBuilderProps) {
  const { toast } = useToast();
  const [storefrontUrl, setStorefrontUrl] = useState(initialUrl);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchStorefrontUrl = async () => {
      try {
        const response = await fetch("/api/settings/storefront-url");
        if (response.ok) {
          const data = await response.json();
          setStorefrontUrl(data.storefrontUrl || "/");
        }
      } catch (error) {
        console.error("Error fetching storefront URL:", error);
      }
    };
    fetchStorefrontUrl();
  }, []);

  const handleSave = async () => {
    if (isLoading) return;
    setIsLoading(true);

    try {
      const response = await fetch("/api/settings/storefront-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storefrontUrl: storefrontUrl || "/" }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.details || "Failed to save storefront URL");
      }

      toast({
        title: "Success!",
        description: "Storefront URL saved successfully.",
        variant: "default",
        action: <CheckCircle2 className="h-5 w-5 text-green-500" />,
      });
    } catch (error) {
      console.error("Error saving storefront URL:", error);
      toast({
        title: "Save Failed",
        description:
          error instanceof Error
            ? error.message
            : "An unexpected error occurred.",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const testUrl = () => {
    const url =
      storefrontUrl?.startsWith("http") || storefrontUrl?.startsWith("/")
        ? storefrontUrl
        : `/${storefrontUrl}`;
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="space-y-4 max-w-xl">
      <div className="space-y-2">
        <Label htmlFor="storefront-url">Store URL</Label>
        <div className="flex gap-2">
          <Input
            id="storefront-url"
            value={storefrontUrl}
            onChange={(e) => setStorefrontUrl(e.target.value)}
            placeholder="/"
            className="flex-1"
          />
          {storefrontUrl && (
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
          onClick={handleSave}
          disabled={isLoading}
          className="min-w-[120px]"
        >
          {isLoading ? (
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
