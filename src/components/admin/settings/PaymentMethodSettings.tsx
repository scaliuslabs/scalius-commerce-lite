// src/components/admin/settings/PaymentMethodSettings.tsx
// Admin component for configuring which payment methods are available on the storefront.

import React, { useState, useEffect, useCallback } from "react";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
    Loader2,
    Save,
    CreditCard,
    Banknote,
    Shield,
    CheckCircle2,
    AlertTriangle,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

interface GatewayStatus {
    configured: boolean;
    enabled: boolean;
}

interface PaymentMethodsData {
    enabledMethods: ("stripe" | "sslcommerz" | "cod")[];
    defaultMethod: "stripe" | "sslcommerz" | "cod";
    gatewayStatus: {
        stripe: GatewayStatus;
        sslcommerz: GatewayStatus;
        cod: GatewayStatus;
    };
}

const METHOD_INFO = {
    stripe: {
        label: "Stripe",
        description: "Accept international card payments",
        icon: CreditCard,
        settingsPath: "/admin/settings/stripe",
    },
    sslcommerz: {
        label: "SSLCommerz",
        description: "Accept local Bangladesh payments (bKash, Nagad, cards)",
        icon: Shield,
        settingsPath: "/admin/settings/sslcommerz",
    },
    cod: {
        label: "Cash on Delivery",
        description: "Collect payment on delivery",
        icon: Banknote,
        settingsPath: null,
    },
} as const;

export default function PaymentMethodSettings() {
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [data, setData] = useState<PaymentMethodsData | null>(null);
    const [enabledMethods, setEnabledMethods] = useState<Set<string>>(new Set(["cod"]));
    const [defaultMethod, setDefaultMethod] = useState<string>("cod");

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch("/api/settings/payment-methods");
            if (res.ok) {
                const json = await res.json() as PaymentMethodsData;
                setData(json);
                setEnabledMethods(new Set(json.enabledMethods));
                setDefaultMethod(json.defaultMethod);
            }
        } catch {
            toast.error("Failed to load payment methods");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        fetchData();
    }, [fetchData]);

    const toggleMethod = (method: string) => {
        setEnabledMethods((prev) => {
            const next = new Set(prev);
            if (next.has(method)) {
                // Don't allow disabling the last method
                if (next.size <= 1) {
                    toast.error("At least one payment method must be enabled");
                    return prev;
                }
                next.delete(method);
                // If we removed the default, pick first remaining
                if (defaultMethod === method) {
                    setDefaultMethod(Array.from(next)[0]);
                }
            } else {
                next.add(method);
            }
            return next;
        });
    };

    const handleSave = async () => {
        setSaving(true);
        try {
            const methods = Array.from(enabledMethods);
            const res = await fetch("/api/settings/payment-methods", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    enabledMethods: methods,
                    defaultMethod,
                }),
            });

            if (res.ok) {
                toast.success("Payment methods updated!");
                fetchData();
            } else {
                const err = await res.json();
                toast.error(err.error || "Failed to save");
            }
        } catch {
            toast.error("An error occurred while saving");
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

    const methods = ["stripe", "sslcommerz", "cod"] as const;

    return (
        <div className="space-y-6 max-w-2xl">
            <div className="flex justify-between items-center">
                <div>
                    <h2 className="text-2xl font-bold tracking-tight">Payment Methods</h2>
                    <p className="text-muted-foreground">
                        Choose which payment methods customers can use at checkout.
                    </p>
                </div>
                <Button onClick={handleSave} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    <Save className="mr-2 h-4 w-4" />
                    Save
                </Button>
            </div>

            <div className="space-y-4">
                {methods.map((method) => {
                    const info = METHOD_INFO[method];
                    const status = data?.gatewayStatus[method];
                    const isEnabled = enabledMethods.has(method);
                    const Icon = info.icon;
                    const needsCredentials = method !== "cod" && !status?.configured;

                    return (
                        <Card
                            key={method}
                            className={`transition-all ${isEnabled ? "border-primary/30 bg-primary/[0.02]" : "opacity-70"}`}
                        >
                            <CardHeader className="pb-3">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-3">
                                        <div
                                            className={`flex h-10 w-10 items-center justify-center rounded-lg ${isEnabled
                                                    ? "bg-primary/10 text-primary"
                                                    : "bg-muted text-muted-foreground"
                                                }`}
                                        >
                                            <Icon className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <CardTitle className="text-base flex items-center gap-2">
                                                {info.label}
                                                {isEnabled && status?.configured && (
                                                    <Badge variant="default" className="text-xs">
                                                        <CheckCircle2 className="h-3 w-3 mr-1" />
                                                        Active
                                                    </Badge>
                                                )}
                                                {isEnabled && needsCredentials && (
                                                    <Badge variant="destructive" className="text-xs">
                                                        <AlertTriangle className="h-3 w-3 mr-1" />
                                                        No Credentials
                                                    </Badge>
                                                )}
                                            </CardTitle>
                                            <CardDescription className="mt-0.5">
                                                {info.description}
                                            </CardDescription>
                                        </div>
                                    </div>
                                    <Switch
                                        checked={isEnabled}
                                        onCheckedChange={() => toggleMethod(method)}
                                        aria-label={`Enable ${info.label}`}
                                    />
                                </div>
                            </CardHeader>
                            {isEnabled && needsCredentials && (
                                <CardContent className="pt-0">
                                    <Alert variant="destructive">
                                        <AlertTriangle className="h-4 w-4" />
                                        <AlertDescription className="text-sm">
                                            {info.label} is enabled but credentials are not configured.{" "}
                                            {info.settingsPath && (
                                                <a
                                                    href={info.settingsPath}
                                                    className="font-medium underline underline-offset-4"
                                                >
                                                    Configure {info.label} →
                                                </a>
                                            )}
                                        </AlertDescription>
                                    </Alert>
                                </CardContent>
                            )}
                        </Card>
                    );
                })}
            </div>

            {/* Default Method Selector */}
            <Card>
                <CardHeader>
                    <CardTitle className="text-base">Default Payment Method</CardTitle>
                    <CardDescription>
                        This method will be pre-selected on the checkout page.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Select value={defaultMethod} onValueChange={setDefaultMethod}>
                        <SelectTrigger className="w-full max-w-xs">
                            <SelectValue placeholder="Select default method" />
                        </SelectTrigger>
                        <SelectContent>
                            {methods
                                .filter((m) => enabledMethods.has(m))
                                .map((method) => {
                                    const info = METHOD_INFO[method];
                                    return (
                                        <SelectItem key={method} value={method}>
                                            {info.label}
                                        </SelectItem>
                                    );
                                })}
                        </SelectContent>
                    </Select>
                </CardContent>
            </Card>

            <div className="flex justify-end pb-4">
                <Button onClick={handleSave} disabled={saving} size="lg">
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Payment Methods
                </Button>
            </div>
        </div>
    );
}
