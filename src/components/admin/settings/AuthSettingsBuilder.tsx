import React, { useState, useEffect } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Save, CheckCircle2, ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const MASKED_VALUE = "••••••••••••";

export default function AuthSettingsBuilder() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [authVerificationMethod, setAuthVerificationMethod] = useState<"email" | "phone" | "both">("email");
    const [guestCheckoutEnabled, setGuestCheckoutEnabled] = useState(true);

    const [whatsappAccessToken, setWhatsappAccessToken] = useState("");
    const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState("");
    const [whatsappTemplateName, setWhatsappTemplateName] = useState("auth_otp");

    const [accessTokenConfigured, setAccessTokenConfigured] = useState(false);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/settings/auth");
            if (res.ok) {
                const data = await res.json();
                setAuthVerificationMethod(data.authVerificationMethod || "email");
                setGuestCheckoutEnabled(data.guestCheckoutEnabled !== false); // default true
                setWhatsappAccessToken(data.whatsappAccessToken || "");
                setWhatsappPhoneNumberId(data.whatsappPhoneNumberId || "");
                setWhatsappTemplateName(data.whatsappTemplateName || "auth_otp");
                setAccessTokenConfigured(!!data.whatsappAccessToken);
            }
        } catch {
            toast.error("Failed to load auth settings");
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setSaving(true);

        try {
            const res = await fetch("/api/settings/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    authVerificationMethod,
                    guestCheckoutEnabled,
                    whatsappAccessToken,
                    whatsappPhoneNumberId,
                    whatsappTemplateName
                }),
            });

            if (res.ok) {
                toast.success("Auth settings saved successfully!");
                fetchSettings();
            } else {
                const err = await res.json();
                toast.error(err.message || "Failed to save auth settings");
            }
        } catch {
            toast.error("An error occurred while saving user settings");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center p-8">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-6 max-w-2xl">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Authentication & Checkout</h2>
                    <p className="text-muted-foreground">
                        Configure how customers log in and whether they can checkout as guests.
                    </p>
                </div>
                <Button onClick={handleSubmit} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save Changes
                </Button>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>Global Access Rules</CardTitle>
                    <CardDescription>
                        Control fundamental account requirements during the storefront flow.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Enable Guest Checkout</Label>
                            <p className="text-sm text-muted-foreground">
                                If disabled, users MUST create an account or login to proceed to the payment stage.
                            </p>
                        </div>
                        <Switch
                            checked={guestCheckoutEnabled}
                            onCheckedChange={setGuestCheckoutEnabled}
                        />
                    </div>

                    <div className="space-y-2">
                        <Label>Authentication Verification Method</Label>
                        <p className="text-sm text-muted-foreground mb-2">
                            Select which channels can receive One-Time Passwords (OTPs). "Both" allows the customer to choose. Phone strictly uses WhatsApp.
                        </p>
                        <Select
                            value={authVerificationMethod}
                            onValueChange={(val: "email" | "phone" | "both") => setAuthVerificationMethod(val)}
                        >
                            <SelectTrigger>
                                <SelectValue placeholder="Select allowed modes" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="email">Email Only</SelectItem>
                                <SelectItem value="phone">WhatsApp Only</SelectItem>
                                <SelectItem value="both">Both (User's Choice)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {(authVerificationMethod === "phone" || authVerificationMethod === "both") && (
                <Card className="border-green-500/20 shadow-[0_0_15px_rgba(34,197,94,0.05)] dark:bg-green-950/10">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            Meta WhatsApp Cloud API
                            {accessTokenConfigured && (
                                <CheckCircle2 className="h-5 w-5 text-green-500" />
                            )}
                        </CardTitle>
                        <CardDescription>
                            Configure standard WhatsApp Business API settings to dispatch OTP messages.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <Alert>
                            <AlertDescription className="text-sm">
                                <strong>Important:</strong> You must create an approved message template inside your Meta Business Manager.
                                The template should expect one variable: {"{{1}}"} where the 6-digit OTP will be injected.
                                See <a href="https://developers.facebook.com/docs/whatsapp/cloud-api/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">Meta Docs <ExternalLink className="h-3 w-3" /></a>.
                            </AlertDescription>
                        </Alert>

                        <div className="space-y-2">
                            <Label htmlFor="wa-access-token">Permanent System User Access Token</Label>
                            <Input
                                id="wa-access-token"
                                type="password"
                                placeholder={accessTokenConfigured ? MASKED_VALUE : "EAAxXXXXXXXXXXXXXXXXXXXXXX"}
                                value={whatsappAccessToken}
                                onChange={(e) => setWhatsappAccessToken(e.target.value)}
                                className="font-mono"
                            />
                            {accessTokenConfigured && whatsappAccessToken === MASKED_VALUE && (
                                <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                                    <CheckCircle2 className="h-3 w-3" /> Token configured.
                                </p>
                            )}
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <Label htmlFor="wa-phone-id">Phone Number ID</Label>
                                <Input
                                    id="wa-phone-id"
                                    placeholder="e.g. 1045934589234"
                                    value={whatsappPhoneNumberId}
                                    onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label htmlFor="wa-template">Message Template Name</Label>
                                <Input
                                    id="wa-template"
                                    placeholder="e.g. auth_otp"
                                    value={whatsappTemplateName}
                                    onChange={(e) => setWhatsappTemplateName(e.target.value)}
                                />
                            </div>
                        </div>

                    </CardContent>
                </Card>
            )}

            <div className="flex justify-end pb-4">
                <Button onClick={handleSubmit} disabled={saving} size="lg">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Auth Configurations
                </Button>
            </div>
        </div>
    );
}
