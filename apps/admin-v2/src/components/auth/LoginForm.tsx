import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { AlertCircle, Loader2, Lock, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { storePendingTwoFactorMethods } from "@/lib/two-factor-pending";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

interface SignInResponse {
  error?: { message?: string } | null;
  twoFactorRedirect?: boolean;
  twoFactorMethods?: readonly unknown[];
}

function getSignInError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Invalid email or password.";
}

export function LoginForm() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = (await authClient.signIn.email({
        email,
        password,
        rememberMe,
        callbackURL: "/admin",
        fetchOptions: { throw: true },
      })) as SignInResponse;

      if (response.error) {
        setError(response.error.message || "Invalid email or password.");
        setIsLoading(false);
        return;
      }

      if (response.twoFactorRedirect) {
        storePendingTwoFactorMethods(response.twoFactorMethods);
        await navigate({ to: "/auth/two-factor" });
        return;
      }

      await navigate({ to: "/admin" });
    } catch (signInError) {
      setPassword("");
      setError(getSignInError(signInError));
      setIsLoading(false);
    }
  }

  return (
    <Card className="w-full border-0 bg-transparent shadow-none">
      <CardHeader className="space-y-2 px-0 pt-0 text-center">
        <CardTitle className="text-2xl font-semibold tracking-tight">
          Sign in
        </CardTitle>
        <CardDescription>
          Use your Scalius admin account to continue.
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0 pb-0">
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div
              role="alert"
              className="flex items-center gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive"
            >
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="email"
                name="email"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="admin@example.com"
                autoComplete="email"
                autoFocus
                required
                disabled={isLoading}
                className="h-11 pl-10"
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="password">Password</Label>
              <Link
                to="/auth/forgot-password"
                className="text-xs font-medium text-primary hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="password"
                name="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                required
                disabled={isLoading}
                className="h-11 pl-10"
              />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={rememberMe}
              onChange={(event) => setRememberMe(event.target.checked)}
              disabled={isLoading}
              className="h-4 w-4 rounded border-input accent-primary"
            />
            Keep me signed in
          </label>

          <Button type="submit" className="h-11 w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
