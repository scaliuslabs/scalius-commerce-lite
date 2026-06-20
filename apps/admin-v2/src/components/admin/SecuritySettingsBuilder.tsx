import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { getSecuritySettings, updateSecuritySettings } from "@/lib/api-functions/settings";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";

interface SecurityValues {
  cspAllowedDomains: string;
}

const fetchSecurity = async (): Promise<SecurityValues> => {
  const data = (await getSecuritySettings()) as Record<string, unknown>;
  return {
    cspAllowedDomains: (data.cspAllowedDomains as string) || "",
  };
};

const saveSecurity = async (values: SecurityValues) => {
  await updateSecuritySettings({
    data: { cspAllowedDomains: values.cspAllowedDomains.trim() },
  });
};

export function SecuritySettingsBuilder() {
  const { values, setValue, isLoading, isSaving, handleSubmit } =
    useSettingsForm<SecurityValues>({
      queryKey: queryKeys.settings.security(),
      fetchFn: fetchSecurity,
      saveFn: saveSecurity,
      defaultValues: { cspAllowedDomains: "" },
      successMessage: "Security settings saved successfully.",
      errorMessage: "Failed to save security settings.",
    });

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
        <Label htmlFor="csp-allowed-domains">
          CSP Allowed Domains
        </Label>
        <Input
          id="csp-allowed-domains"
          value={values.cspAllowedDomains}
          onChange={(e) => setValue("cspAllowedDomains", e.target.value)}
          placeholder="store.scalius.com, admin.scalius.com, *.facebook.com"
          className="w-full"
        />
        <p className="text-xs text-muted-foreground">
          Comma-separated domains without protocols (e.g.,{" "}
          <code className="text-[0.8em] bg-muted px-1 py-0.5 rounded">
            store.scalius.com
          </code>
          ). Wildcards supported (e.g.,{" "}
          <code className="text-[0.8em] bg-muted px-1 py-0.5 rounded">
            *.facebook.com
          </code>
          ). These domains are used for storefront content security policy only.
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
            "Save Settings"
          )}
        </Button>
      </div>
    </div>
  );
}
