// src/components/auth/AuthCard.tsx
// Better Auth UI AuthCard wrapper with custom styling
import { AuthUIProvider, AuthForm } from "@daveyplate/better-auth-ui";
import { authClient } from "@/lib/auth-client";
import { Toaster } from "sonner";

type AuthView = "SIGN_IN" | "SIGN_UP" | "FORGOT_PASSWORD" | "RESET_PASSWORD" | "TWO_FACTOR";

interface AuthCardProps {
  view?: AuthView;
  redirectTo?: string;
  callbackURL?: string;
}

export function AuthCard({ view = "SIGN_IN", redirectTo = "/admin", callbackURL }: AuthCardProps) {
  return (
    <AuthUIProvider
      authClient={authClient}
      navigate={(path) => {
        window.location.href = path;
      }}
      replace={(path) => {
        window.location.replace(path);
      }}
      onSessionChange={() => {
        window.location.href = redirectTo;
      }}
      twoFactor={["otp", "totp"]}
      credentials={true}
      viewPaths={{
        SIGN_IN: "login",
        SIGN_UP: "setup",
        FORGOT_PASSWORD: "forgot-password",
        RESET_PASSWORD: "reset-password",
        TWO_FACTOR: "two-factor",
      }}
      basePath="/auth"
      redirectTo={redirectTo}
    >
      <Toaster position="top-center" richColors />
      <div className="w-full">
        <AuthForm
          view={view}
          redirectTo={redirectTo}
          callbackURL={callbackURL}
          classNames={{
            base: "space-y-4",
            primaryButton: "w-full h-11",
            input: "h-11",
            label: "text-sm font-medium",
            error: "text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg p-3",
          }}
        />
      </div>
    </AuthUIProvider>
  );
}
