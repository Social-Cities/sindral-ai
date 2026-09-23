"use client";

import { useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { signInAction, signUpAction } from "@/lib/actions/auth";

interface AuthFormProps {
  onSubmit: (email: string, password: string) => Promise<{
    ok: boolean;
    error?: string;
  }>;
  submitLabel: string;
  pendingLabel: string;
}

function AuthForm({ onSubmit, submitLabel, pendingLabel }: AuthFormProps) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const handle = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await onSubmit(email, password);
      if (!result.ok) {
        setError(result.error ?? "Something went wrong.");
        return;
      }
      router.replace("/inbox");
      router.refresh();
    });
  };

  return (
    <form onSubmit={handle} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label className="field">
        <span className="field-label">Email</span>
        <input
          className="field-input"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <label className="field">
        <span className="field-label">Password</span>
        <input
          className="field-input"
          type="password"
          autoComplete="current-password"
          required
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error && (
        <div style={{ color: "var(--type-bug)", fontSize: 12.5 }}>{error}</div>
      )}
      <button
        type="submit"
        className="btn primary"
        disabled={pending || !email || !password}
        style={{ marginTop: 4 }}
      >
        {pending ? pendingLabel : submitLabel}
      </button>
    </form>
  );
}

export function LoginForm() {
  return (
    <AuthForm
      onSubmit={signInAction}
      submitLabel="Sign in"
      pendingLabel="Signing in…"
    />
  );
}

export function SignUpForm() {
  return (
    <AuthForm
      onSubmit={signUpAction}
      submitLabel="Create account"
      pendingLabel="Creating account…"
    />
  );
}
