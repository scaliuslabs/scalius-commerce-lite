import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { CheckCircle2, HelpCircle } from "lucide-react";
import {
  type PolarData,
  PasswordInput,
  LiveWarning,
  SaveBtn,
  SandboxToggle,
  ExtLink,
} from "./payment-gateway-utils";

interface PolarFormProps {
  s: PolarData;
  set: React.Dispatch<React.SetStateAction<PolarData>>;
  conf: { token: boolean; webhook: boolean };
  saving: boolean;
  onSave: () => void;
  onHelp: () => void;
}

export function PolarForm({ s, set, conf, saving, onSave, onHelp }: PolarFormProps) {
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSave(); }} className="space-y-3 pt-2">
      <div className="flex items-center justify-between rounded-md border border-border/70 px-3 py-2">
        <div className="space-y-0.5">
          <Label htmlFor="polar-enabled" className="text-sm">Provider enabled</Label>
          <p className="text-xs text-muted-foreground">Allows Polar sessions after credentials are complete.</p>
        </div>
        <Switch
          id="polar-enabled"
          checked={s.enabled}
          onCheckedChange={(v) => set((p) => ({ ...p, enabled: v }))}
        />
      </div>
      <SandboxToggle checked={s.sandbox} onChange={(v) => set((p) => ({ ...p, sandbox: v }))}
        extra={<Button type="button" variant="ghost" size="sm" className="text-xs gap-1 text-muted-foreground h-7" onClick={onHelp}>
          <HelpCircle className="h-3.5 w-3.5" /> Setup Guide
        </Button>} />
      {!s.sandbox && s.enabled && <LiveWarning message="Live mode enabled. Real payments will be processed." />}
      <div className="space-y-1.5">
        <Label htmlFor="polar-tok" className="flex items-center gap-1.5 text-sm">
          Access Token {conf.token && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
        </Label>
        <PasswordInput id="polar-tok" value={s.accessToken} onChange={(v) => set((p) => ({ ...p, accessToken: v }))}
          placeholder="polar_pat_..." configured={conf.token} />
        <p className="text-xs text-muted-foreground"><ExtLink href="https://polar.sh/settings">polar.sh/settings</ExtLink></p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="polar-wh" className="flex items-center gap-1.5 text-sm">
          Webhook Secret {conf.webhook && <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />}
        </Label>
        <PasswordInput id="polar-wh" value={s.webhookSecret} onChange={(v) => set((p) => ({ ...p, webhookSecret: v }))}
          placeholder="polar_whs_..." configured={conf.webhook} />
        <p className="text-xs text-muted-foreground">Add endpoint <code className="text-xs bg-muted px-1 rounded">/api/v1/webhooks/polar</code> in Polar webhooks.</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="polar-pid" className="text-sm">Product ID</Label>
        <Input id="polar-pid" type="text" value={s.productId} className="font-mono"
          onChange={(e) => set((p) => ({ ...p, productId: e.target.value }))} placeholder="prod_..." />
        <p className="text-xs text-muted-foreground">Create a generic product on Polar and paste its ID here.</p>
      </div>
      <SaveBtn saving={saving} label="Save Polar" />
    </form>
  );
}

export function PolarSetupGuide() {
  const steps = [
    { t: "Create a Polar Account", c: <>Sign up at <ExtLink href="https://polar.sh">polar.sh</ExtLink> and create an organization.</> },
    { t: "Generate an Access Token", c: <>Go to <ExtLink href="https://polar.sh/settings">Organization Settings</ExtLink> &rarr; <strong>Access Tokens</strong> &rarr; Create a token with <code className="bg-muted px-1 rounded text-xs">checkouts:write</code> scope.</> },
    { t: "Create a Generic Product", c: <>In Polar Dashboard &rarr; <strong>Products</strong> &rarr; Create a product. Copy the <strong>Product ID</strong> from the &hellip; menu.</> },
    { t: "Configure Webhooks", c: <>Add endpoint <code className="block bg-muted px-3 py-2 rounded text-xs break-all mt-1">https://your-domain.com/api/v1/webhooks/polar</code>Select events: <code className="bg-muted px-1 rounded text-xs">checkout.updated</code> and <code className="bg-muted px-1 rounded text-xs">order.paid</code>.</> },
    { t: "Enable & Save", c: <>Turn <strong>Provider enabled</strong> on, click <strong>Save Polar</strong>, then use <strong>Show at checkout</strong> on the gateway card when you are ready for customers to see it.</> },
  ];
  return (
    <div className="space-y-4 text-sm">
      {steps.map((s, i) => (
        <div key={i} className="space-y-2">
          <h4 className="font-semibold flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-indigo-700 text-xs font-bold dark:bg-indigo-900 dark:text-indigo-300">{i + 1}</span>
            {s.t}
          </h4>
          <p className="text-muted-foreground pl-7">{s.c}</p>
        </div>
      ))}
      <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-4 py-3 mt-2">
        <p className="text-amber-800 dark:text-amber-200 text-xs">
          <strong>Tip:</strong> Start with <strong>Sandbox Mode</strong> enabled to test without charging real customers.
        </p>
      </div>
    </div>
  );
}
