import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Loader2, Save, CheckCircle2, AlertTriangle, ExternalLink,
  Eye, EyeOff,
} from "lucide-react";

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

// --- Gateway Logo SVGs ---

export const StripeLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4" fill="url(#sg)" />
    <path d="M11.2 9.4c0-.7.6-1 1.5-1 1.3 0 3 .4 4.3 1.1V5.8c-1.4-.6-2.9-.8-4.3-.8C9.8 5 7.5 6.7 7.5 9.6c0 4.5 6.2 3.8 6.2 5.7 0 .8-.7 1.1-1.7 1.1-1.5 0-3.4-.6-4.9-1.4v3.8c1.7.7 3.3 1 4.9 1 2.9 0 5-1.4 5-4.4 0-4.8-6.2-4-6.2-5.9z" fill="white" />
    <defs><linearGradient id="sg" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#635bff" /><stop offset="1" stopColor="#7a73ff" /></linearGradient></defs>
  </svg>
);

export const SSLCommerzLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4" fill="#16a34a" />
    <path d="M12 4a3.5 3.5 0 0 0-3.5 3.5V9H7v9a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V9h-1.5V7.5A3.5 3.5 0 0 0 12 4zm0 1.5a2 2 0 0 1 2 2V9h-4V7.5a2 2 0 0 1 2-2zm0 6a1.5 1.5 0 0 1 .75 2.8V16a.75.75 0 0 1-1.5 0v-1.7A1.5 1.5 0 0 1 12 11.5z" fill="white" />
  </svg>
);

export const PolarLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4" fill="url(#pg)" />
    <path d="M13.5 4L9 13h4l-2.5 7L16 11h-4l1.5-7z" fill="white" />
    <defs><linearGradient id="pg" x1="0" y1="0" x2="24" y2="24"><stop stopColor="#6366f1" /><stop offset="1" stopColor="#8b5cf6" /></linearGradient></defs>
  </svg>
);

export const CODLogo = ({ className }: { className?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <rect width="24" height="24" rx="4" fill="#16a34a" />
    <rect x="4" y="7" width="16" height="10" rx="1.5" fill="white" opacity="0.9" />
    <circle cx="12" cy="12" r="2.5" fill="#16a34a" />
    <path d="M12 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="white" />
  </svg>
);

export const META: Record<MethodKey, {
  label: string; desc: string; Logo: React.FC<{ className?: string }>;
  borderColor: string; headerBg: string;
}> = {
  stripe: { label: "Stripe", desc: "Accept card payments globally", Logo: StripeLogo, borderColor: "border-violet-500/20 dark:border-violet-500/10", headerBg: "bg-violet-50/50 dark:bg-violet-950/10" },
  sslcommerz: { label: "SSLCommerz", desc: "BD payments (bKash, Nagad, cards)", Logo: SSLCommerzLogo, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
  polar: { label: "Polar", desc: "Global digital payments", Logo: PolarLogo, borderColor: "border-indigo-500/20 dark:border-indigo-500/10", headerBg: "bg-indigo-50/50 dark:bg-indigo-950/10" },
  cod: { label: "Cash on Delivery", desc: "Collect payment on delivery", Logo: CODLogo, borderColor: "border-green-500/20 dark:border-green-500/10", headerBg: "bg-green-50/50 dark:bg-green-950/10" },
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
      <button type="button" onClick={() => setShow((s) => !s)} tabIndex={-1}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
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

export function SaveBtn({ saving, label }: { saving: boolean; label: string }) {
  return (
    <div className="flex justify-end pt-1">
      <Button type="submit" disabled={saving} size="sm">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
        {label}
      </Button>
    </div>
  );
}

export function SandboxToggle({ checked, onChange, extra }: {
  checked: boolean; onChange: (v: boolean) => void; extra?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <p className="text-sm font-medium">Sandbox Mode</p>
        <p className="text-xs text-muted-foreground">Use test credentials</p>
      </div>
      <div className="flex items-center gap-2">
        {extra}
        <Switch checked={checked} onCheckedChange={onChange} />
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
