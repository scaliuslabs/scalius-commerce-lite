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
import { Loader2, Save, AlertTriangle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { unwrapEnvelope, extractApiError } from "@/lib/api-helpers";

export default function CheckoutFlowSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);

    const [guestCheckoutEnabled, setGuestCheckoutEnabled] = useState(true);
    const [checkoutMode, setCheckoutMode] = useState<string>("all");
    const [partialPaymentEnabled, setPartialPaymentEnabled] = useState(false);
    const [partialPaymentAmount, setPartialPaymentAmount] = useState<number>(0);

    useEffect(() => {
        fetchSettings();
    }, []);

    const fetchSettings = async () => {
        try {
            const res = await fetch("/api/v1/admin/settings/auth");
            if (res.ok) {
                const json = await res.json();
                const data = unwrapEnvelope(json);
                setGuestCheckoutEnabled(data.guestCheckoutEnabled !== false);
                setCheckoutMode(data.checkoutMode || "all");
                setPartialPaymentEnabled(data.partialPaymentEnabled || false);
                setPartialPaymentAmount(data.partialPaymentAmount || 0);
            }
        } catch {
            toast.error("Failed to load checkout flow settings");
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
                    guestCheckoutEnabled,
                    checkoutMode,
                    partialPaymentEnabled,
                    partialPaymentAmount,
                }),
            });

            if (res.ok) {
                toast.success("Checkout flow settings saved successfully!");
                fetchSettings();
            } else {
                const err = await res.json();
                toast.error(extractApiError(err, "Failed to save checkout flow settings"));
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
                    <CardTitle className="text-base">Guest Checkout</CardTitle>
                    <CardDescription>
                        Allow customers to place orders without creating an account.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Enable Guest Checkout</Label>
                            <p className="text-xs text-muted-foreground">
                                When enabled, customers can checkout without logging in (subject to the Checkout Mode below).
                            </p>
                        </div>
                        <Switch
                            checked={guestCheckoutEnabled}
                            onCheckedChange={setGuestCheckoutEnabled}
                        />
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Checkout Mode</CardTitle>
                    <CardDescription>
                        Determine which payment flows and methods are available to customers at checkout.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-1.5">
                        <Label>Available Payment Flows</Label>
                        <p className="text-xs text-muted-foreground mb-1.5">
                            Controls which payment options customers see during checkout.
                        </p>
                        <Select
                            value={checkoutMode}
                            onValueChange={(val) => setCheckoutMode(val)}
                        >
                            <SelectTrigger className="w-full max-w-xs">
                                <SelectValue placeholder="Select checkout mode" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">Standard (All Methods Available)</SelectItem>
                                <SelectItem value="guest_cod_only">Fast COD Only (Direct from Cart)</SelectItem>
                                <SelectItem value="gateways_only">Online Gateways Only (No COD)</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </CardContent>
            </Card>

            <Card>
                <CardHeader className="pb-3">
                    <CardTitle className="text-base">Partial Payment / Advance Deposit</CardTitle>
                    <CardDescription>
                        Require customers to pay a specific amount upfront to confirm their order. Useful for COD orders.
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <Label>Enable Partial Payment</Label>
                            <p className="text-xs text-muted-foreground">
                                When enabled, customers must pay a flat advance amount via an online gateway before their order is confirmed.
                            </p>
                        </div>
                        <Switch
                            checked={partialPaymentEnabled}
                            onCheckedChange={setPartialPaymentEnabled}
                        />
                    </div>

                    {partialPaymentEnabled && (
                        <div className="space-y-3 pl-4 border-l-2 border-primary/20">
                            <div className="space-y-1.5">
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

                            {partialPaymentAmount === 0 && (
                                <Alert className="border-amber-500/30 bg-amber-500/5">
                                    <AlertTriangle className="h-4 w-4 text-amber-500" />
                                    <AlertDescription className="text-sm text-amber-700 dark:text-amber-400">
                                        Partial payment is enabled but the amount is set to 0. Customers will not be charged any advance deposit.
                                    </AlertDescription>
                                </Alert>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className="flex justify-end pt-4 border-t border-border">
                <Button
                    onClick={() => handleSubmit()}
                    disabled={saving}
                    className="min-w-[140px]"
                >
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save Settings
                </Button>
            </div>
        </div>
    );
}
