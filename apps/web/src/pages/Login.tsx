import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Logo } from '@/components/Layout';

type Mode = 'signin' | 'signup';

export function Login() {
  const { session, loading, signIn, signUp } = useAuth();
  const location = useLocation();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/';
  if (!loading && session) return <Navigate to={from} replace />;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
      } else {
        const { needsConfirmation } = await signUp(email, password);
        if (needsConfirmation) setNotice('Check your inbox to confirm your email, then sign in.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2.5 justify-center mb-8">
          <Logo size={28} />
          <span className="text-base font-semibold tracking-tight text-foreground">Sindral AI</span>
        </div>

        <div className="rounded-xl bg-card border border-border overflow-hidden">
          <div className="flex border-b border-border" role="tablist" aria-label="Authentication mode">
            {(['signin', 'signup'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                  setNotice(null);
                }}
                className={`flex-1 px-4 py-2.5 text-xs font-medium transition-colors relative ${
                  mode === m ? 'text-foreground' : 'text-muted-foreground hover:text-secondary-foreground'
                }`}
              >
                {m === 'signin' ? 'Sign in' : 'Create account'}
                {mode === m && <span className="absolute bottom-0 left-0 right-0 h-px bg-accent" />}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="p-5 space-y-4">
            <Input
              label="Email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
            <Input
              label="Password"
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              required
              minLength={6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            {error && (
              <p className="text-xs text-[#f87171]" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="text-xs text-[#34d399]" role="status">
                {notice}
              </p>
            )}
            <Button type="submit" size="md" loading={busy} className="w-full">
              {mode === 'signin' ? 'Sign in' : 'Create account'}
            </Button>

          </form>
        </div>

        <p className="text-[10px] text-muted-foreground text-center mt-6 leading-relaxed">
          Tasks move from todo to PR via AI agents running on your own machine.
        </p>
      </div>
    </div>
  );
}
