import { useState, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Loader2 } from "lucide-react";

const CheckoutFlowSettings = lazy(() =>
    import("./CheckoutFlowSettings")
);
const PaymentGatewaysManager = lazy(() =>
    import("./PaymentGatewaysManager")
);
const CheckoutLanguagesManager = lazy(() =>
    import("../checkout-languages").then((m) => ({
        default: m.CheckoutLanguagesManager,
    }))
);
const ShippingMethodsManager = lazy(() =>
    import("../shipping-methods").then((m) => ({
        default: m.ShippingMethodsManager,
    }))
);
const DeliveryLocationsManager = lazy(() =>
    import("../delivery-locations").then((m) => ({
        default: m.DeliveryLocationsManager,
    }))
);

function TabSpinner() {
    return (
        <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
    );
}

const tabs = [
    { value: "checkout-flow", label: "Checkout Flow" },
    { value: "payment", label: "Payment Gateways" },
    { value: "languages", label: "Languages" },
    { value: "shipping", label: "Shipping Methods" },
    { value: "delivery", label: "Delivery Locations" },
] as const;

export default function CheckoutSettingsPage() {
    const [activeTab, setActiveTab] = useState("checkout-flow");
    const [mountedTabs, setMountedTabs] = useState<Set<string>>(
        () => new Set(["checkout-flow"])
    );

    const handleTabChange = (value: string) => {
        setActiveTab(value);
        setMountedTabs((prev) => {
            if (prev.has(value)) return prev;
            const next = new Set(prev);
            next.add(value);
            return next;
        });
    };

    return (
        <div className="max-w-5xl mx-auto">
            <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight">
                    Checkout Settings
                </h1>
                <p className="text-sm text-muted-foreground mt-1">
                    Checkout flow, payment gateways, languages, shipping methods, and delivery
                    locations.
                </p>
            </div>

            <Tabs
                value={activeTab}
                onValueChange={handleTabChange}
                className="w-full"
            >
                <TabsList className="w-full justify-start rounded-none border-b border-border bg-transparent p-0 h-auto flex-wrap gap-0">
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:text-foreground data-[state=active]:shadow-none data-[state=active]:bg-transparent hover:text-foreground"
                        >
                            {tab.label}
                        </TabsTrigger>
                    ))}
                </TabsList>

                <div className="mt-6">
                    <TabsContent value="checkout-flow" className="mt-0">
                        {mountedTabs.has("checkout-flow") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CheckoutFlowSettings />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="payment" className="mt-0">
                        {mountedTabs.has("payment") && (
                            <Suspense fallback={<TabSpinner />}>
                                <PaymentGatewaysManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="languages" className="mt-0">
                        {mountedTabs.has("languages") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CheckoutLanguagesManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="shipping" className="mt-0">
                        {mountedTabs.has("shipping") && (
                            <Suspense fallback={<TabSpinner />}>
                                <ShippingMethodsManager />
                            </Suspense>
                        )}
                    </TabsContent>

                    <TabsContent value="delivery" className="mt-0">
                        {mountedTabs.has("delivery") && (
                            <Suspense fallback={<TabSpinner />}>
                                <DeliveryLocationsManager />
                            </Suspense>
                        )}
                    </TabsContent>
                </div>
            </Tabs>
        </div>
    );
}
