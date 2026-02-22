import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, CheckCircle2 } from "lucide-react";

export function SecuritySettingsBuilder() {
    const { toast } = useToast();
    const [cspAllowedDomains, setCspAllowedDomains] = useState("");
    const [isLoading, setIsLoading] = useState(false);
    const [isFetching, setIsFetching] = useState(true);

    useEffect(() => {
        const fetchSecuritySettings = async () => {
            try {
                const response = await fetch("/api/settings/security");
                if (response.ok) {
                    const data = await response.json();
                    setCspAllowedDomains(data.cspAllowedDomains || "");
                }
            } catch (error) {
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
            const response = await fetch("/api/settings/security", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ cspAllowedDomains: cspAllowedDomains.trim() }),
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(
                    error.details || "Failed to save security settings"
                );
            }

            toast({
                title: "Success!",
                description: "Security settings saved successfully.",
                variant: "default",
                action: <CheckCircle2 className="h-5 w-5 text-green-500" />,
            });
        } catch (error) {
            console.error("Error saving security settings:", error);
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
