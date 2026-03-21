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
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

const MASKED_VALUE = "••••••••••••";

export default function AuthSettingsBuilder() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [authVerificationMethod, setAuthVerificationMethod] = useState<string>("email");

    const [whatsappAccessToken, setWhatsappAccessToken] = useState("");
    const [whatsappPhoneNumberId, setWhatsappPhoneNumberId] = useState("");
    const [whatsappTemplateName, setWhatsappTemplateName] = useState("auth_otp");

    const [accessTokenConfigured, setAccessTokenConfigured] = useState(false);

    // SMS OTP provider settings
    const [smsProvider, setSmsProvider] = useState<string>("");
    const [smsnetbdApiKey, setSmsnetbdApiKey] = useState("");
    const [smsnetbdSenderId, setSmsnetbdSenderId] = useState("");
    const [bdbulksmsToken, setBdbulksmsToken] = useState("");
    const [mimsmsUsername, setMimsmsUsername] = useState("");
    const [mimsmsApiKey, setMimsmsApiKey] = useState("");
    const [mimsmsSenderName, setMimsmsSenderName] = useState("");
    const [gennetApiToken, setGennetApiToken] = useState("");
    const [gennetBaseUrl, setGennetBaseUrl] = useState("");
    const [gennetSid, setGennetSid] = useState("");
    const [smsConfigured, setSmsConfigured] = useState(false);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/v1/admin/settings/auth");
            if (res.ok) {
                const json = await res.json();
                const data = unwrapEnvelope(json);
                setAuthVerificationMethod(data.authVerificationMethod || "email");
                setWhatsappAccessToken(data.whatsappAccessToken || "");
                setWhatsappPhoneNumberId(data.whatsappPhoneNumberId || "");
                setWhatsappTemplateName(data.whatsappTemplateName || "auth_otp");
                setAccessTokenConfigured(!!data.whatsappAccessToken);
            }

            // Also fetch SMS settings
            try {
                const smsRes = await fetch("/api/v1/admin/settings/sms");
                if (smsRes.ok) {
                    const smsJson = await smsRes.json();
                    const smsData = unwrapEnvelope(smsJson);
                    setSmsProvider(smsData.activeProvider || "");
                    setSmsnetbdApiKey(smsData.smsnetbdApiKey || "");
                    setSmsnetbdSenderId(smsData.smsnetbdSenderId || "");
                    setBdbulksmsToken(smsData.bdbulksmsToken || "");
                    setMimsmsUsername(smsData.mimsmsUsername || "");
                    setMimsmsApiKey(smsData.mimsmsApiKey || "");
                    setMimsmsSenderName(smsData.mimsmsSenderName || "");
                    setGennetApiToken(smsData.gennetApiToken || "");
                    setGennetBaseUrl(smsData.gennetBaseUrl || "");
                    setGennetSid(smsData.gennetSid || "");
                    setSmsConfigured(!!smsData.activeProvider);
                }
            } catch {
                // SMS settings fetch failure is non-fatal
            }
        } catch {
            toast.error("Failed to load auth settings");
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e?: React.SyntheticEvent) => {
        e?.preventDefault();
        setSaving(true);

        try {
            const res = await fetch("/api/v1/admin/settings/auth", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    authVerificationMethod,
                    whatsappAccessToken,
                    whatsappPhoneNumberId,
                    whatsappTemplateName,
                }),
            });

            if (res.ok) {
                // Save SMS settings separately (different endpoint, different storage)
                if (authVerificationMethod === "sms_otp" && smsProvider) {
                    const smsRes = await fetch("/api/v1/admin/settings/sms", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            activeProvider: smsProvider,
                            smsnetbdApiKey,
                            smsnetbdSenderId,
                            bdbulksmsToken,
                            mimsmsUsername,
                            mimsmsApiKey,
                            mimsmsSenderName,
                            gennetApiToken,
                            gennetBaseUrl,
                            gennetSid,
                        }),
                    });
                    if (!smsRes.ok) {
                        const err = await smsRes.json();
                        toast.error(extractApiError(err, "Failed to save SMS settings"));
                        return;
                    }
                }
                toast.success("Auth settings saved successfully!");
                fetchSettings();
            } else {
                const err = await res.json();
                toast.error(extractApiError(err, "Failed to save auth settings"));
            }
        } catch {
            toast.error("An error occurred while saving");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
        );
    }

    return (
        <div className="space-y-5 max-w-2xl">
            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Account Verification</CardTitle>
                    <CardDescription>
                        Configure how customers verify their identity when creating an account or logging in.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="space-y-1.5">
                        <Label>Account Verification Method</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            How customers verify their identity when creating an account or logging in.
                        </p>
                        <Select
                            value={authVerificationMethod}
                            onValueChange={(val) => setAuthVerificationMethod(val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select verification method" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="email">Email OTP (Phone collected at signup)</SelectItem>
                                <SelectItem value="phone">WhatsApp OTP (Phone verified, Email optional)</SelectItem>
                                <SelectItem value="both">Both Options (Customer's Pick)</SelectItem>
                                <SelectItem value="sms_otp">SMS OTP (Phone verified via SMS)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {(authVerificationMethod === "phone" ||
                authVerificationMethod === "both") && (
                    <Card className="border-green-500/20 dark:bg-green-950/10">
                        <CardHeader className="pb-3">
                            <CardTitle className="text-base flex items-center gap-2">
                                Meta WhatsApp Cloud API
                                {accessTokenConfigured && (
                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                )}
                            </CardTitle>
                            <CardDescription>
                                Configure WhatsApp Business API for OTP delivery.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <Alert>
                                <AlertDescription className="text-sm">
                                    Create an approved message template with one variable{" "}
                                    {"{{1}}"} for the OTP code.{" "}
                                    <a
                                        href="https://developers.facebook.com/docs/whatsapp/cloud-api/"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        Meta Docs <ExternalLink className="h-3 w-3" />
                                    </a>
                                </AlertDescription>
                            </Alert>

                            <div className="space-y-1.5">
                                <Label htmlFor="wa-access-token">
                                    Permanent System User Access Token
                                </Label>
                                <Input
                                    id="wa-access-token"
                                    type="password"
                                    placeholder={
                                        accessTokenConfigured
                                            ? MASKED_VALUE
                                            : "EAAxXXXXXXXXXXXXXXXXXXXXXX"
                                    }
                                    value={whatsappAccessToken}
                                    onChange={(e) => setWhatsappAccessToken(e.target.value)}
                                    className="font-mono"
                                />
                                {accessTokenConfigured &&
                                    whatsappAccessToken === MASKED_VALUE && (
                                        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                                            <CheckCircle2 className="h-3 w-3" /> Token configured.
                                        </p>
                                    )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div className="space-y-1.5">
                                    <Label htmlFor="wa-phone-id">Phone Number ID</Label>
                                    <Input
                                        id="wa-phone-id"
                                        placeholder="e.g. 1045934589234"
                                        value={whatsappPhoneNumberId}
                                        onChange={(e) => setWhatsappPhoneNumberId(e.target.value)}
                                    />
                                </div>
                                <div className="space-y-1.5">
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

            {authVerificationMethod === "sms_otp" && (
                <Card className="border-blue-500/20 dark:bg-blue-950/10">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-base flex items-center gap-2">
                            SMS Provider Configuration
                            {smsConfigured && (
                                <CheckCircle2 className="h-4 w-4 text-green-500" />
                            )}
                        </CardTitle>
                        <CardDescription>
                            Select a Bangladesh SMS gateway provider and enter your credentials.
                            Credentials are stored encrypted.
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="space-y-1.5">
                            <Label>SMS Provider</Label>
                            <Select value={smsProvider} onValueChange={setSmsProvider}>
                                <SelectTrigger className="w-full max-w-xs">
                                    <SelectValue placeholder="Select SMS provider" />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="smsnetbd">SMS.net.bd</SelectItem>
                                    <SelectItem value="bdbulksms">BDBulkSMS (GreenWeb)</SelectItem>
                                    <SelectItem value="mimsms">MIM SMS</SelectItem>
                                    <SelectItem value="gennet">Gennet iSMS</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>

                        {/* SMS.net.bd fields */}
                        {smsProvider === "smsnetbd" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="smsnetbd-api-key">API Key</Label>
                                    <Input
                                        id="smsnetbd-api-key"
                                        type="password"
                                        placeholder={smsnetbdApiKey === MASKED_VALUE ? MASKED_VALUE : "Enter your SMS.net.bd API key"}
                                        value={smsnetbdApiKey}
                                        onChange={(e) => setSmsnetbdApiKey(e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="smsnetbd-sender-id">Sender ID (optional)</Label>
                                    <Input
                                        id="smsnetbd-sender-id"
                                        placeholder="Leave blank for default"
                                        value={smsnetbdSenderId}
                                        onChange={(e) => setSmsnetbdSenderId(e.target.value)}
                                    />
                                </div>
                            </div>
                        )}

                        {/* BDBulkSMS fields */}
                        {smsProvider === "bdbulksms" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="bdbulksms-token">API Token</Label>
                                    <Input
                                        id="bdbulksms-token"
                                        type="password"
                                        placeholder={bdbulksmsToken === MASKED_VALUE ? MASKED_VALUE : "Enter your BDBulkSMS token"}
                                        value={bdbulksmsToken}
                                        onChange={(e) => setBdbulksmsToken(e.target.value)}
                                        className="font-mono"
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Generate at{" "}
                                        <a href="https://gwb.li/token" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                                            gwb.li/token <ExternalLink className="inline h-3 w-3" />
                                        </a>
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* MIM SMS fields */}
                        {smsProvider === "mimsms" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-username">Username (Email)</Label>
                                    <Input
                                        id="mimsms-username"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={mimsmsUsername}
                                        onChange={(e) => setMimsmsUsername(e.target.value)}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-api-key">API Key</Label>
                                    <Input
                                        id="mimsms-api-key"
                                        type="password"
                                        placeholder={mimsmsApiKey === MASKED_VALUE ? MASKED_VALUE : "Enter your MIM SMS API key"}
                                        value={mimsmsApiKey}
                                        onChange={(e) => setMimsmsApiKey(e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-sender-name">Sender Name</Label>
                                    <Input
                                        id="mimsms-sender-name"
                                        placeholder="Must be registered with MIM SMS"
                                        value={mimsmsSenderName}
                                        onChange={(e) => setMimsmsSenderName(e.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Your sender name must be pre-approved by MIM SMS before it will work.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Gennet iSMS fields */}
                        {smsProvider === "gennet" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="gennet-api-token">API Token</Label>
                                    <Input
                                        id="gennet-api-token"
                                        type="password"
                                        placeholder={gennetApiToken === MASKED_VALUE ? MASKED_VALUE : "Enter your Gennet API token"}
                                        value={gennetApiToken}
                                        onChange={(e) => setGennetApiToken(e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="gennet-base-url">Base URL</Label>
                                    <Input
                                        id="gennet-base-url"
                                        placeholder="https://yoursubdomain.gennet.com.bd"
                                        value={gennetBaseUrl}
                                        onChange={(e) => setGennetBaseUrl(e.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Account-specific domain provided by GenNet on signup.
                                    </p>
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="gennet-sid">Sender ID (SID)</Label>
                                    <Input
                                        id="gennet-sid"
                                        placeholder="Assigned by GenNet"
                                        value={gennetSid}
                                        onChange={(e) => setGennetSid(e.target.value)}
                                    />
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            <div className="flex justify-end pt-4 border-t border-border">
                <Button
                    onClick={() => handleSubmit()}
                    disabled={saving}
                    className="min-w-[140px]"
                >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save Auth Settings
                </Button>
            </div>
        </div>
    );
}
