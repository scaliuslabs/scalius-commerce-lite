import React from "react";
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
import { Loader2, Save, CheckCircle2, ExternalLink } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useSettingsForm } from "@/hooks/use-settings-form";
import { queryKeys } from "@/lib/query-keys";
import {
    getAuthSettings,
    updateAuthSettings,
    getSmsSettings,
    updateSmsSettings,
} from "@/lib/api-functions/settings";

const MASKED_VALUE = "••••••••••••";
const AUTH_METHODS_WITH_SMS = new Set(["phone", "both", "sms_otp"]);

function normalizeAuthVerificationMethod(method: unknown): string {
    // `phone` is a legacy persisted value. The backend routes it through SMS.
    return method === "phone" ? "sms_otp" : (typeof method === "string" && method ? method : "email");
}

function usesSmsProvider(method: string): boolean {
    return AUTH_METHODS_WITH_SMS.has(method);
}

function usesWhatsAppProvider(method: string): boolean {
    return method === "whatsapp_otp";
}

interface AuthAndSmsSettings {
    // Auth settings
    authVerificationMethod: string;
    whatsappAccessToken: string;
    whatsappPhoneNumberId: string;
    whatsappTemplateName: string;
    // SMS settings
    smsProvider: string;
    smsnetbdApiKey: string;
    smsnetbdSenderId: string;
    bdbulksmsToken: string;
    mimsmsUsername: string;
    mimsmsApiKey: string;
    mimsmsSenderName: string;
    gennetApiToken: string;
    gennetBaseUrl: string;
    gennetSid: string;
}

const defaultValues: AuthAndSmsSettings = {
    authVerificationMethod: "email",
    whatsappAccessToken: "",
    whatsappPhoneNumberId: "",
    whatsappTemplateName: "auth_otp",
    smsProvider: "",
    smsnetbdApiKey: "",
    smsnetbdSenderId: "",
    bdbulksmsToken: "",
    mimsmsUsername: "",
    mimsmsApiKey: "",
    mimsmsSenderName: "",
    gennetApiToken: "",
    gennetBaseUrl: "",
    gennetSid: "",
};

async function fetchAuthAndSms(): Promise<Partial<AuthAndSmsSettings>> {
    const result: Partial<AuthAndSmsSettings> = {};

    const authData = await getAuthSettings() as Record<string, unknown>;
    result.authVerificationMethod = normalizeAuthVerificationMethod(authData.authVerificationMethod);
    result.whatsappAccessToken = (authData.whatsappAccessToken as string) || "";
    result.whatsappPhoneNumberId = (authData.whatsappPhoneNumberId as string) || "";
    result.whatsappTemplateName = (authData.whatsappTemplateName as string) || "auth_otp";

    // SMS fetch is non-fatal
    try {
        const smsData = await getSmsSettings() as Record<string, unknown>;
        result.smsProvider = (smsData.activeProvider as string) || "";
        result.smsnetbdApiKey = (smsData.smsnetbdApiKey as string) || "";
        result.smsnetbdSenderId = (smsData.smsnetbdSenderId as string) || "";
        result.bdbulksmsToken = (smsData.bdbulksmsToken as string) || "";
        result.mimsmsUsername = (smsData.mimsmsUsername as string) || "";
        result.mimsmsApiKey = (smsData.mimsmsApiKey as string) || "";
        result.mimsmsSenderName = (smsData.mimsmsSenderName as string) || "";
        result.gennetApiToken = (smsData.gennetApiToken as string) || "";
        result.gennetBaseUrl = (smsData.gennetBaseUrl as string) || "";
        result.gennetSid = (smsData.gennetSid as string) || "";
    } catch {
        // SMS settings fetch failure is non-fatal
    }

    return result;
}

async function saveAuthAndSms(v: AuthAndSmsSettings): Promise<void> {
    const authVerificationMethod = normalizeAuthVerificationMethod(v.authVerificationMethod);

    await updateAuthSettings({
        data: {
            authVerificationMethod,
            whatsappAccessToken: v.whatsappAccessToken,
            whatsappPhoneNumberId: v.whatsappPhoneNumberId,
            whatsappTemplateName: v.whatsappTemplateName,
        },
    });

    // Save SMS settings separately (different endpoint, different storage)
    if (usesSmsProvider(authVerificationMethod) && v.smsProvider) {
        await updateSmsSettings({
            data: {
                activeProvider: v.smsProvider,
                smsnetbdApiKey: v.smsnetbdApiKey,
                smsnetbdSenderId: v.smsnetbdSenderId,
                bdbulksmsToken: v.bdbulksmsToken,
                mimsmsUsername: v.mimsmsUsername,
                mimsmsApiKey: v.mimsmsApiKey,
                mimsmsSenderName: v.mimsmsSenderName,
                gennetApiToken: v.gennetApiToken,
                gennetBaseUrl: v.gennetBaseUrl,
                gennetSid: v.gennetSid,
            },
        });
    }
}

export default function AuthSettingsBuilder() {
    const { values, setValue, isLoading, isSaving, handleSubmit } = useSettingsForm<AuthAndSmsSettings>({
        queryKey: queryKeys.settings.auth(),
        fetchFn: fetchAuthAndSms,
        saveFn: saveAuthAndSms,
        defaultValues,
        successMessage: "Auth settings saved successfully!",
        errorMessage: "Failed to save auth settings",
    });

    // Derive configured status from current values
    const accessTokenConfigured = !!values.whatsappAccessToken;
    const smsConfigured = !!values.smsProvider;

    if (isLoading) {
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
                            value={values.authVerificationMethod}
                            onValueChange={(val) => setValue("authVerificationMethod", val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select verification method" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="email">Email OTP</SelectItem>
                                <SelectItem value="sms_otp">SMS OTP</SelectItem>
                                <SelectItem value="whatsapp_otp">WhatsApp OTP</SelectItem>
                                <SelectItem value="both">Email or SMS OTP</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            {usesWhatsAppProvider(values.authVerificationMethod) && (
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
                                    value={values.whatsappAccessToken}
                                    onChange={(e) => setValue("whatsappAccessToken", e.target.value)}
                                    className="font-mono"
                                />
                                {accessTokenConfigured &&
                                    values.whatsappAccessToken === MASKED_VALUE && (
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
                                        value={values.whatsappPhoneNumberId}
                                        onChange={(e) => setValue("whatsappPhoneNumberId", e.target.value)}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="wa-template">Message Template Name</Label>
                                    <Input
                                        id="wa-template"
                                        placeholder="e.g. auth_otp"
                                        value={values.whatsappTemplateName}
                                        onChange={(e) => setValue("whatsappTemplateName", e.target.value)}
                                    />
                                </div>
                            </div>
                        </CardContent>
                </Card>
            )}

            {usesSmsProvider(values.authVerificationMethod) && (
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
                            <Select value={values.smsProvider} onValueChange={(val) => setValue("smsProvider", val)}>
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
                        {values.smsProvider === "smsnetbd" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="smsnetbd-api-key">API Key</Label>
                                    <Input
                                        id="smsnetbd-api-key"
                                        type="password"
                                        placeholder={values.smsnetbdApiKey === MASKED_VALUE ? MASKED_VALUE : "Enter your SMS.net.bd API key"}
                                        value={values.smsnetbdApiKey}
                                        onChange={(e) => setValue("smsnetbdApiKey", e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="smsnetbd-sender-id">Sender ID (optional)</Label>
                                    <Input
                                        id="smsnetbd-sender-id"
                                        placeholder="Leave blank for default"
                                        value={values.smsnetbdSenderId}
                                        onChange={(e) => setValue("smsnetbdSenderId", e.target.value)}
                                    />
                                </div>
                            </div>
                        )}

                        {/* BDBulkSMS fields */}
                        {values.smsProvider === "bdbulksms" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="bdbulksms-token">API Token</Label>
                                    <Input
                                        id="bdbulksms-token"
                                        type="password"
                                        placeholder={values.bdbulksmsToken === MASKED_VALUE ? MASKED_VALUE : "Enter your BDBulkSMS token"}
                                        value={values.bdbulksmsToken}
                                        onChange={(e) => setValue("bdbulksmsToken", e.target.value)}
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
                        {values.smsProvider === "mimsms" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-username">Username (Email)</Label>
                                    <Input
                                        id="mimsms-username"
                                        type="email"
                                        placeholder="you@example.com"
                                        value={values.mimsmsUsername}
                                        onChange={(e) => setValue("mimsmsUsername", e.target.value)}
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-api-key">API Key</Label>
                                    <Input
                                        id="mimsms-api-key"
                                        type="password"
                                        placeholder={values.mimsmsApiKey === MASKED_VALUE ? MASKED_VALUE : "Enter your MIM SMS API key"}
                                        value={values.mimsmsApiKey}
                                        onChange={(e) => setValue("mimsmsApiKey", e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="mimsms-sender-name">Sender Name</Label>
                                    <Input
                                        id="mimsms-sender-name"
                                        placeholder="Must be registered with MIM SMS"
                                        value={values.mimsmsSenderName}
                                        onChange={(e) => setValue("mimsmsSenderName", e.target.value)}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        Your sender name must be pre-approved by MIM SMS before it will work.
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Gennet iSMS fields */}
                        {values.smsProvider === "gennet" && (
                            <div className="space-y-3 pt-2 border-t">
                                <div className="space-y-1.5">
                                    <Label htmlFor="gennet-api-token">API Token</Label>
                                    <Input
                                        id="gennet-api-token"
                                        type="password"
                                        placeholder={values.gennetApiToken === MASKED_VALUE ? MASKED_VALUE : "Enter your Gennet API token"}
                                        value={values.gennetApiToken}
                                        onChange={(e) => setValue("gennetApiToken", e.target.value)}
                                        className="font-mono"
                                    />
                                </div>
                                <div className="space-y-1.5">
                                    <Label htmlFor="gennet-base-url">Base URL</Label>
                                    <Input
                                        id="gennet-base-url"
                                        placeholder="https://yoursubdomain.gennet.com.bd"
                                        value={values.gennetBaseUrl}
                                        onChange={(e) => setValue("gennetBaseUrl", e.target.value)}
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
                                        value={values.gennetSid}
                                        onChange={(e) => setValue("gennetSid", e.target.value)}
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
                    disabled={isSaving}
                    className="min-w-[140px]"
                >
                    {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save Auth Settings
                </Button>
            </div>
        </div>
    );
}
