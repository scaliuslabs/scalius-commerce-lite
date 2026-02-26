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

    const [authVerificationMethod, setAuthVerificationMethod] = useState<string>("email");
    const [guestCheckoutEnabled, setGuestCheckoutEnabled] = useState(true);
    const [checkoutMode, setCheckoutMode] = useState<string>("all");
    const [partialPaymentEnabled, setPartialPaymentEnabled] = useState(false);
    const [partialPaymentAmount, setPartialPaymentAmount] = useState<number>(0);

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
                setGuestCheckoutEnabled(data.guestCheckoutEnabled !== false);
                setWhatsappAccessToken(data.whatsappAccessToken || "");
                setWhatsappPhoneNumberId(data.whatsappPhoneNumberId || "");
                setWhatsappTemplateName(data.whatsappTemplateName || "auth_otp");
                setCheckoutMode(data.checkoutMode || "all");
                setPartialPaymentEnabled(data.partialPaymentEnabled || false);
                setPartialPaymentAmount(data.partialPaymentAmount || 0);
                setAccessTokenConfigured(!!data.whatsappAccessToken);
            }
        } catch {
            toast.error("Failed to load auth settings");
        } finally {
            setLoading(false);
        }
    };

    const handleSubmit = async (e?: React.FormEvent) => {
        e?.preventDefault();
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
                    whatsappTemplateName,
                    checkoutMode,
                    partialPaymentEnabled,
                    partialPaymentAmount,
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
                    <CardTitle className="text-base">Global Access Rules</CardTitle>
                    <CardDescription>
                        Control account requirements during the storefront checkout flow.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-5">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Guest Checkout</Label>
                            <p className="text-xs text-muted-foreground">
                                When disabled, users must create an account to proceed to
                                payment.
                            </p>
                        </div>
                        <Switch
                            checked={guestCheckoutEnabled}
                            onCheckedChange={setGuestCheckoutEnabled}
                        />
                    </div>

                    <div className="space-y-1.5">
                        <Label>Verification Method</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            OTP delivery channel. "Both" lets the customer choose. Phone uses
                            WhatsApp.
                        </p>
                        <Select
                            value={authVerificationMethod}
                            onValueChange={(val) => setAuthVerificationMethod(val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select mode" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="email">Email Only</SelectItem>
                                <SelectItem value="phone">WhatsApp Only</SelectItem>
                                <SelectItem value="both">Both (User's Choice)</SelectItem>
                                <SelectItem value="email_phone_mandatory">Email + WhatsApp (Mandatory)</SelectItem>
                                <SelectItem value="sms_otp">SMS OTP (Custom Integration)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-1.5 pt-4 border-t border-border">
                        <Label>Checkout Mode</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            Determine if customers are forced to use specific payment methods or flows.
                        </p>
                        <Select
                            value={checkoutMode}
                            onValueChange={(val) => setCheckoutMode(val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select checkout mode" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Standard (All Methods)</SelectItem>
                                <SelectItem value="guest_cod_only">Guest COD Only (Fastest)</SelectItem>
                                <SelectItem value="gateways_only">Online Gateways Only (No COD)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="space-y-4 pt-4 border-t border-border">
                        <div className="flex items-center justify-between">
                            <div className="space-y-0.5">
                                <Label>Partial Payment / Advance Deposit</Label>
                                <p className="text-xs text-muted-foreground">
                                    Require customers to pay a specific amount upfront to confirm their order. Useful for COD orders.
                                </p>
                            </div>
                            <Switch
                                checked={partialPaymentEnabled}
                                onCheckedChange={setPartialPaymentEnabled}
                            />
                        </div>

                        {partialPaymentEnabled && (
                            <div className="space-y-1.5 pl-4 border-l-2 border-primary/20">
                                <Label htmlFor="partial-payment-amount">Advance Amount Required</Label>
                                <Input
                                    id="partial-payment-amount"
                                    type="number"
                                    min="0"
                                    className="max-w-xs"
                                    placeholder="e.g. 200"
                                    value={partialPaymentAmount}
                                    onChange={(e) => setPartialPaymentAmount(Number(e.target.value))}
                                />
                                <p className="text-xs text-muted-foreground mt-1">
                                    Customers must pay this flat amount via an online gateway to successfully place an order.
                                </p>
                            </div>
                        )}
                    </div>
                </CardContent>
            </Card>

            {(authVerificationMethod === "phone" ||
                authVerificationMethod === "both" || authVerificationMethod === "email_phone_mandatory") && (
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
