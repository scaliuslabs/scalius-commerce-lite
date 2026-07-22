import { useEffect, useRef, useState, lazy, Suspense } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { Loader2 } from "lucide-react";
import type { CheckoutSettingsSection } from "./checkout-settings-sections";

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
const CustomerRequestSettings = lazy(() =>
    import("./CustomerRequestSettings")
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
    { value: "customer-requests", label: "Customer Requests" },
] as const;

interface CheckoutSettingsPageProps {
    section: CheckoutSettingsSection;
    onSectionChange: (section: CheckoutSettingsSection) => void;
}

export default function CheckoutSettingsPage({
    section,
    onSectionChange,
}: CheckoutSettingsPageProps) {
    const [mountedTabs, setMountedTabs] = useState<Set<string>>(
        () => new Set([section])
    );
    const tabListRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef(new Map<CheckoutSettingsSection, HTMLButtonElement>());

    useEffect(() => {
        setMountedTabs((prev) => {
            if (prev.has(section)) return prev;
            const next = new Set(prev);
            next.add(section);
            return next;
        });
    }, [section]);

    useEffect(() => {
        const frame = window.requestAnimationFrame(() => {
            const list = tabListRef.current;
            const activeTab = tabRefs.current.get(section);
            if (!list || !activeTab) return;
            const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
            const centered = activeTab.offsetLeft
                - (list.clientWidth - activeTab.offsetWidth) / 2;
            list.scrollTo({
                left: Math.max(0, Math.min(maxScroll, centered)),
                behavior: "auto",
            });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [section]);

    const handleTabChange = (value: string) => {
        onSectionChange(value as CheckoutSettingsSection);
    };

    return (
        <div className="mx-auto max-w-6xl">
            <div className="mb-4">
                <h1 className="text-xl font-semibold tracking-tight">
                    Checkout Settings
                </h1>
                <p className="mt-0.5 text-sm text-muted-foreground">
                    Buyer access, payment, localization, shipping, delivery, and post-purchase requests.
                </p>
            </div>

            <Tabs
                value={section}
                onValueChange={handleTabChange}
                className="w-full"
            >
                <TabsList
                    ref={tabListRef}
                    aria-label="Checkout settings sections"
                    className="h-auto w-full scroll-px-3 justify-start gap-0 overflow-x-auto rounded-none border-b border-border bg-transparent p-0 [scrollbar-width:thin]"
                >
                    {tabs.map((tab) => (
                        <TabsTrigger
                            key={tab.value}
                            value={tab.value}
                            ref={(element) => {
                                if (element) tabRefs.current.set(tab.value, element);
                                else tabRefs.current.delete(tab.value);
                            }}
                            className="min-h-11 shrink-0 rounded-none border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-muted-foreground transition-none data-[state=active]:border-b-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none hover:text-foreground sm:px-4"
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

                    <TabsContent value="customer-requests" className="mt-0">
                        {mountedTabs.has("customer-requests") && (
                            <Suspense fallback={<TabSpinner />}>
                                <CustomerRequestSettings />
                            </Suspense>
                        )}
                    </TabsContent>
                </div>
            </Tabs>
        </div>
    );
}
