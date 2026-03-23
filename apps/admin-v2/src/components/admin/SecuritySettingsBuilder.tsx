import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { getServerFnError } from "@/lib/api-helpers";
import { getSecuritySettings, updateSecuritySettings } from "@/lib/api.functions";

export function SecuritySettingsBuilder() {
    const [cspAllowedDomains, setCspAllowedDomains] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isFetching, setIsFetching] = useState(true);

    useEffect(() => {
        const fetchSecuritySettings = async () => {
            try {
                const data = await getSecuritySettings() as Record<string, unknown>;
                setCspAllowedDomains((data.cspAllowedDomains as string) || "");
            } catch (error: unknown) {
                console.error("Error fetching security settings:", error);
            } finally {
                setIsFetching(false);
            }
        };
        fetchSecuritySettings();
    }, []);

    const handleSave = async () => {
        if (isLoading) return;
        setIsLoading(true);

        try {
            await updateSecuritySettings({ data: { cspAllowedDomains: cspAllowedDomains.trim() } });
            toast.success("Success!", { description: "Security settings saved successfully." });
        } catch (error: unknown) {
            console.error("Error saving security settings:", error);
            toast.error("Save Failed", { description: getServerFnError(error, "An unexpected error occurred.") });
        } finally {
            setIsLoading(false);
        }
    };

    if (isFetching) {
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
                    CORS & CSP Allowed Domains
                </Label>
                <Input
                    id="csp-allowed-domains"
                    value={cspAllowedDomains}
                    onChange={(e) => setCspAllowedDomains(e.target.value)}
                    placeholder="store.scalius.com, admin.scalius.com, *.facebook.com"
                    className="w-full"
                />
                <p className="text-xs text-muted-foreground">
                    Comma-separated domains without protocols (e.g.,{" "}
                    <code className="text-[0.8em] bg-muted px-1 py-0.5 rounded">store.scalius.com</code>).
                    Wildcards supported (e.g.,{" "}
                    <code className="text-[0.8em] bg-muted px-1 py-0.5 rounded">*.facebook.com</code>).
                    Synced to Edge Cache immediately on save.
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
                        "Save Settings"
                    )}
                </Button>
            </div>
        </div>
    );
}
