import { useState } from 'react';
import type { FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { useAuth } from '@/auth/AuthProvider';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { Logo } from '@/components/Layout';

type Mode = 'signin' | 'signup';

export function Login() {
  const { session, loading, signIn, signUp, signInWithGitHub } = useAuth();
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

  async function handleGitHub() {
    setError(null);
    setBusy(true);
    try {
      await signInWithGitHub();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'GitHub sign-in failed');
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

            <div className="flex items-center gap-3 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
              <span className="flex-1 h-px bg-border" />
              or
              <span className="flex-1 h-px bg-border" />
            </div>

            <Button type="button" variant="subtle" size="md" onClick={handleGitHub} disabled={busy} className="w-full">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
              </svg>
              Continue with GitHub
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
