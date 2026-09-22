import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { displayNameFor, useAuth } from '@/auth/AuthProvider';
import type { LiveStatus } from '@/hooks/useServerEvents';

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: '/', label: 'Home', end: true },
  { to: '/tasks', label: 'Tasks' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/settings', label: 'Settings' },
];

interface LayoutProps {
  children: ReactNode;
  liveStatus?: LiveStatus;
}

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <div
      className="rounded-md bg-primary flex items-center justify-center shadow-lg shadow-primary/20 shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg width={size / 2} height={size / 2} viewBox="0 0 12 12" fill="none">
        <path d="M2 10L6 2L10 10" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M3.5 7.5H8.5" stroke="white" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function Layout({ children, liveStatus }: LayoutProps) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const name = displayNameFor(user, 'Account');
  const initial = (name.charAt(0) || '?').toUpperCase();

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  async function handleSignOut() {
    setMenuOpen(false);
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="shrink-0 flex items-center justify-between px-3 sm:px-6 h-13 border-b border-border gap-2">
        <Link to="/" className="flex items-center gap-2.5 group" aria-label="Sindral AI home">
          <Logo />
          <span className="hidden sm:inline text-sm font-semibold tracking-tight text-foreground">Sindral AI</span>
        </Link>

        <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Primary">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                `px-2 sm:px-3 py-1.5 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
                  isActive ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-secondary-foreground hover:bg-secondary/40'
                }`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="flex items-center gap-3">
          {liveStatus && (
            <span
              className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground"
              title={liveStatus === 'open' ? 'Live updates connected' : liveStatus === 'connecting' ? 'Connecting live updates…' : 'Live updates disconnected'}
            >
              <span
                aria-hidden="true"
                className={`w-1.5 h-1.5 rounded-full ${
                  liveStatus === 'open' ? 'bg-emerald-400' : liveStatus === 'connecting' ? 'bg-amber-400 animate-pulse' : 'bg-muted-foreground'
                }`}
              />
              <span className="sr-only">Live updates {liveStatus}</span>
            </span>
          )}
          <div className="relative" ref={menuRef}>
            <button
              type="button"
              onClick={() => setMenuOpen((o) => !o)}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Account menu for ${name}`}
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold cursor-pointer text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
              style={{
                background: 'linear-gradient(135deg, #7c3aed22 0%, #818cf822 100%)',
                border: '1px solid #818cf840',
              }}
            >
              {initial}
            </button>
            {menuOpen && (
              <div role="menu" className="absolute right-0 top-full mt-2 w-48 rounded-md bg-card border border-border py-1 z-30 shadow-xl">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-xs font-medium text-foreground truncate">{name}</p>
                  {user?.email && <p className="text-[10px] font-mono text-muted-foreground truncate">{user.email}</p>}
                </div>
                <Link
                  role="menuitem"
                  to="/settings"
                  onClick={() => setMenuOpen(false)}
                  className="block px-3 py-2 text-xs text-secondary-foreground hover:text-foreground hover:bg-secondary/60"
                >
                  Settings
                </Link>
                <button
                  role="menuitem"
                  type="button"
                  onClick={handleSignOut}
                  className="w-full text-left px-3 py-2 text-xs text-secondary-foreground hover:text-foreground hover:bg-secondary/60"
                >
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-hidden">
        <div className="h-[calc(100vh-52px)]">{children}</div>
      </main>
    </div>
  );
}
