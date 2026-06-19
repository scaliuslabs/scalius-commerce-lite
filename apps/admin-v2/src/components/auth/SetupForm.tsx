import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { runSetup } from "@/lib/api-functions/auth-management";
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
import { Loader2, Mail, Lock, User, AlertCircle } from "lucide-react";

export function SetupForm() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleCreateAccount = async (e: React.SyntheticEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    if (password.length < 12) {
      setError("Password must be at least 12 characters");
      return;
    }

    setIsLoading(true);

    try {
      try {
        await runSetup({ data: { name, email, password } });
      } catch (setupError: unknown) {
        setError(setupError instanceof Error ? setupError.message : "Failed to create account");
        setIsLoading(false);
        return;
      }

      const signInResult = await authClient.signIn.email({
        email,
        password,
      });

      if (signInResult.error) {
        // If sign-in fails, redirect to login page
        console.error("Sign in after setup failed:", signInResult.error);
        await navigate({ to: "/auth/login" });
        return;
      }

      await navigate({ to: "/admin" });
      return;
    } catch (err: unknown) {
      console.error("Setup error:", err);
      setError("An unexpected error occurred. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full shadow-lg border-border/50 bg-card/95 backdrop-blur-sm">
      <CardHeader className="space-y-1 text-center">
        <CardTitle className="text-2xl font-bold tracking-tight">
          Welcome to Scalius Commerce
        </CardTitle>
        <CardDescription>
          Create your admin account to get started
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleCreateAccount} className="space-y-4">
          {error && (
            <div className="flex items-center gap-2 p-3 text-sm text-destructive bg-destructive/10 border border-destructive/20 rounded-lg">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <div className="relative">
              <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="name"
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="pl-10"
                required
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="email"
                type="email"
                placeholder="admin@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="pl-10"
                required
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                placeholder="Create a strong password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="pl-10"
                required
                disabled={isLoading}
                minLength={12}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">Confirm Password</Label>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="confirmPassword"
                type="password"
                placeholder="Confirm your password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="pl-10"
                required
                disabled={isLoading}
                minLength={12}
              />
            </div>
          </div>

          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating account...
              </>
            ) : (
              "Create Admin Account"
            )}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
