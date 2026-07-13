import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2, Save, CheckCircle2, AlertTriangle, ExternalLink,
  Eye, EyeOff, Banknote,
} from "lucide-react";
import { OfficialProviderMark } from "./provider-marks";

export const MASKED = "••••••••••••";

// --- Types ---

export interface GatewayStatus {
  configured: boolean;
  enabled: boolean;
  usable?: boolean;
  missingFields?: string[];
  blockedReason?: string;
  providerEnabled?: boolean;
  checkoutSelected?: boolean;
  checkoutVisible?: boolean;
}
export interface PaymentMethodsData {
  enabledMethods: MethodKey[]; defaultMethod: MethodKey;
  activeMethods?: MethodKey[]; activeDefaultMethod?: MethodKey;
  gatewayStatus: Record<MethodKey, GatewayStatus>;
}
export interface StripeData { secretKey: string; publishableKey: string; webhookSecret: string; enabled: boolean; }
export interface SSLCommerzData { storeId: string; storePassword: string; sandbox: boolean; enabled: boolean; }
export interface PolarData { accessToken: string; webhookSecret: string; productId: string; sandbox: boolean; enabled: boolean; }
export type MethodKey = "stripe" | "sslcommerz" | "polar" | "cod";

// --- Provider marks ---

export const StripeMark = () => <OfficialProviderMark provider="stripe" />;
export const SSLCommerzMark = () => <OfficialProviderMark provider="sslcommerz" />;
export const PolarMark = () => <OfficialProviderMark provider="polar" />;
export const CODIcon = () => (
  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" aria-hidden="true">
    <Banknote className="h-5 w-5" />
  </span>
);

export const META: Record<MethodKey, {
  label: string; desc: string; Mark: React.FC;
  borderColor: string; headerBg: string;
}> = {
  stripe: { label: "Stripe", desc: "Accept card payments globally", Mark: StripeMark, borderColor: "border-violet-500/20 dark:border-violet-500/10", headerBg: "bg-violet-50/50 dark:bg-violet-950/10" },
  sslcommerz: { label: "SSLCommerz", desc: "BD payments (bKash, Nagad, cards)", Mark: SSLCommerzMark, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
  polar: { label: "Polar", desc: "Global digital payments", Mark: PolarMark, borderColor: "border-indigo-500/20 dark:border-indigo-500/10", headerBg: "bg-indigo-50/50 dark:bg-indigo-950/10" },
  cod: { label: "Cash on Delivery", desc: "Collect payment on delivery", Mark: CODIcon, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
};

// --- Reusable sub-components ---

export function PasswordInput({ id, value, onChange, placeholder, configured }: {
  id: string; value: string; onChange: (v: string) => void; placeholder: string; configured: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input id={id} type={show ? "text" : "password"} value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={configured ? MASKED : placeholder} className="font-mono pr-10" />
      <button type="button" onClick={() => setShow((s) => !s)}
        aria-controls={id}
        aria-label={`${show ? "Hide" : "Show"} credential value`}
        className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
      {configured && value === MASKED && (
        <p className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1 mt-1">
          <CheckCircle2 className="h-3 w-3" /> Configured -- type to replace
        </p>
      )}
    </div>
  );
}

export function LiveWarning({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
      <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
      <span><strong>{message}</strong></span>
    </div>
  );
}

export function SaveBtn({ saving, dirty, onReset, label }: { saving: boolean; dirty: boolean; onReset: () => void; label: string }) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-xs text-muted-foreground" aria-live="polite">{dirty ? "Unsaved provider changes" : "Provider settings saved"}</span>
      <div className="flex flex-col-reverse gap-2 sm:flex-row">
      <Button type="button" variant="ghost" disabled={!dirty || saving} size="sm" onClick={onReset}>Reset</Button>
      <Button type="submit" disabled={!dirty || saving} size="sm">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
        {label}
      </Button>
      </div>
    </div>
  );
}

export function SandboxToggle({ id, checked, onChange, extra }: {
  id: string; checked: boolean; onChange: (v: boolean) => void; extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <Label htmlFor={id} className="text-sm font-medium">Sandbox mode</Label>
        <p className="text-xs text-muted-foreground">Use test credentials</p>
      </div>
      <div className="flex items-center gap-2">
        {extra}
        <Switch id={id} checked={checked} onCheckedChange={onChange} />
      </div>
    </div>
  );
}

export function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline">
      {children} <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}
