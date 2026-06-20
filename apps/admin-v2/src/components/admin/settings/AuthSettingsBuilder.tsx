import React from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import {
    CUSTOMER_AUTH_CHANNEL_OPTIONS,
    CUSTOMER_AUTH_METHODS,
    CUSTOMER_AUTH_OTP_CHANNELS,
    customerAuthPolicyUsesSmsProvider,
    customerAuthPolicyUsesWhatsAppProvider,
    getCustomerAuthPolicyForMethod,
    getCustomerAuthMethodLabel,
    getLegacyCustomerAuthMethodForPolicy,
    normalizeCustomerAuthPolicy,
    normalizeCustomerAuthMethod,
    type CustomerAuthMethod,
    type CustomerAuthOtpChannel,
    type CustomerAuthPolicyConfig,
} from "@scalius/shared/customer-auth-policy";

const MASKED_VALUE = "••••••••••••";
type EmailCollectionMode = "none" | "optional" | "required";

function serializeCustomerAuthPolicy(policy: CustomerAuthPolicyConfig) {
    return {
        otpChannels: [...policy.otpChannels],
        requiredContactFields: [...policy.requiredContactFields],
        optionalContactFields: [...policy.optionalContactFields],
        defaultOtpChannel: policy.defaultOtpChannel,
    };
}

function getEmailCollectionMode(policy: CustomerAuthPolicyConfig): EmailCollectionMode {
    if (policy.requiredContactFields.includes("email")) return "required";
    if (policy.optionalContactFields.includes("email")) return "optional";
    return "none";
}

interface AuthAndSmsSettings {
    // Auth settings
    authVerificationMethod: CustomerAuthMethod;
    customerAuthPolicy: CustomerAuthPolicyConfig;
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
    customerAuthPolicy: getCustomerAuthPolicyForMethod("email"),
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

    const authData = await getAuthSettings();
    result.customerAuthPolicy = normalizeCustomerAuthPolicy(
        authData.customerAuthPolicy,
        authData.authVerificationMethod,
    );
    result.authVerificationMethod = getLegacyCustomerAuthMethodForPolicy(result.customerAuthPolicy);
    result.whatsappAccessToken = authData.whatsappAccessToken || "";
    result.whatsappPhoneNumberId = authData.whatsappPhoneNumberId || "";
    result.whatsappTemplateName = authData.whatsappTemplateName || "auth_otp";

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
    const authVerificationMethod = normalizeCustomerAuthMethod(v.authVerificationMethod);
    const customerAuthPolicy = normalizeCustomerAuthPolicy(v.customerAuthPolicy, authVerificationMethod);

    await updateAuthSettings({
        data: {
            authVerificationMethod: getLegacyCustomerAuthMethodForPolicy(customerAuthPolicy),
            customerAuthPolicy: serializeCustomerAuthPolicy(customerAuthPolicy),
            whatsappAccessToken: v.whatsappAccessToken,
            whatsappPhoneNumberId: v.whatsappPhoneNumberId,
            whatsappTemplateName: v.whatsappTemplateName,
        },
    });

    // Save SMS settings separately (different endpoint, different storage)
    if (customerAuthPolicyUsesSmsProvider(customerAuthPolicy) && v.smsProvider) {
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
    const customerAuthPolicy = normalizeCustomerAuthPolicy(
        values.customerAuthPolicy,
        values.authVerificationMethod,
    );

    const setPreset = (value: unknown) => {
        const method = normalizeCustomerAuthMethod(value);
        const policy = getCustomerAuthPolicyForMethod(method);
        setValue("authVerificationMethod", method);
        setValue("customerAuthPolicy", policy);
    };

    const updateCustomerAuthPolicy = (
        updater: (policy: CustomerAuthPolicyConfig) => CustomerAuthPolicyConfig,
    ) => {
        const nextPolicy = normalizeCustomerAuthPolicy(
            updater(customerAuthPolicy),
            values.authVerificationMethod,
        );
        setValue("customerAuthPolicy", nextPolicy);
        setValue("authVerificationMethod", getLegacyCustomerAuthMethodForPolicy(nextPolicy));
    };

    const toggleOtpChannel = (channel: CustomerAuthOtpChannel, checked: boolean) => {
        updateCustomerAuthPolicy((policy) => {
            const current = new Set(policy.otpChannels);
            if (checked) current.add(channel);
            if (!checked && current.size > 1) current.delete(channel);
            const otpChannels = CUSTOMER_AUTH_OTP_CHANNELS.filter((item) => current.has(item));
            return {
                ...policy,
                otpChannels,
                defaultOtpChannel: otpChannels.includes(policy.defaultOtpChannel)
                    ? policy.defaultOtpChannel
                    : otpChannels[0] ?? "email",
            };
        });
    };

    const setEmailCollectionMode = (mode: EmailCollectionMode) => {
        updateCustomerAuthPolicy((policy) => {
            const required = new Set(policy.requiredContactFields);
            const optional = new Set(policy.optionalContactFields);
            required.add("phone");
            required.delete("email");
            optional.delete("email");

            if (mode === "required") {
                required.add("email");
            }
            if (mode === "optional") {
                optional.add("email");
            }

            return {
                ...policy,
                requiredContactFields: ["phone", ...(required.has("email") ? ["email" as const] : [])],
                optionalContactFields: optional.has("email") ? ["email"] : [],
            };
        });
    };

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
                    <CardTitle className="text-base">Customer Login & Account Creation</CardTitle>
                    <CardDescription>
                        Configure verification channels and the contact details collected from customers.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="space-y-1.5">
                        <Label>Quick Preset</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            Start from a common setup, then fine-tune channels and email collection below.
                        </p>
                        <Select
                            value={values.authVerificationMethod}
                            onValueChange={setPreset}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select verification method" />
                            </SelectTrigger>
                            <SelectContent>
                                {CUSTOMER_AUTH_METHODS.map((method) => (
                                    <SelectItem key={method} value={method}>
                                        {getCustomerAuthMethodLabel(method)}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-4 rounded-lg border border-border p-4">
                        <div>
                            <Label>Verification Channels</Label>
                            <p className="text-xs text-muted-foreground mt-1">
                                Customers can choose from the enabled channels during sign in or account creation.
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                            {CUSTOMER_AUTH_OTP_CHANNELS.map((channel) => (
                                <label
                                    key={channel}
                                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                                >
                                    <Checkbox
                                        checked={customerAuthPolicy.otpChannels.includes(channel)}
                                        onCheckedChange={(checked) => toggleOtpChannel(channel, checked === true)}
                                    />
                                    <span>{CUSTOMER_AUTH_CHANNEL_OPTIONS[channel].label}</span>
                                </label>
                            ))}
                        </div>

                        <div className="space-y-3">
                            <Label>Email Collection</Label>
                            <RadioGroup
                                value={getEmailCollectionMode(customerAuthPolicy)}
                                onValueChange={(value) => setEmailCollectionMode(value as EmailCollectionMode)}
                                className="grid grid-cols-1 gap-3 sm:grid-cols-3"
                            >
                                {([
                                    ["none", "Do not collect"],
                                    ["optional", "Optional"],
                                    ["required", "Required"],
                                ] as const).map(([value, label]) => (
                                    <label
                                        key={value}
                                        className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                                    >
                                        <RadioGroupItem value={value} />
                                        <span>{label}</span>
                                    </label>
                                ))}
                            </RadioGroup>

                            <div className="rounded-md border border-border px-3 py-2 text-sm">
                                <div className="flex items-center gap-2">
                                    <CheckCircle2 className="h-4 w-4 text-green-500" />
                                    <span>Phone number required</span>
                                </div>
                            </div>
                        </div>

                        <div className="space-y-1.5">
                            <Label>Default Channel</Label>
                            <Select
                                value={customerAuthPolicy.defaultOtpChannel}
                                onValueChange={(value) => {
                                    if (!CUSTOMER_AUTH_OTP_CHANNELS.includes(value as CustomerAuthOtpChannel)) return;
                                    updateCustomerAuthPolicy((policy) => ({
                                        ...policy,
                                        defaultOtpChannel: value as CustomerAuthOtpChannel,
                                    }));
                                }}
                            >
                                <SelectTrigger className="w-full max-w-xs">
                                    <SelectValue placeholder="Select default channel" />
                                </SelectTrigger>
                                <SelectContent>
                                    {customerAuthPolicy.otpChannels.map((channel) => (
                                        <SelectItem key={channel} value={channel}>
                                            {CUSTOMER_AUTH_CHANNEL_OPTIONS[channel].label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    </div>
                </CardContent>
            </Card>

            {customerAuthPolicyUsesWhatsAppProvider(customerAuthPolicy) && (
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

            {customerAuthPolicyUsesSmsProvider(customerAuthPolicy) && (
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
