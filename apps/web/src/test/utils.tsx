import type { ReactElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { Session, User } from '@supabase/supabase-js';
import { vi } from 'vitest';
import { AuthContext } from '@/auth/AuthProvider';
import type { AuthContextValue } from '@/auth/AuthProvider';

export function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'lucas@example.com',
    app_metadata: {},
    user_metadata: { full_name: 'Lucas' },
    aud: 'authenticated',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as User;
}

export function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  const user = overrides.user ?? makeUser();
  const session = { access_token: 'test-token', user } as unknown as Session;
  return {
    session,
    user,
    loading: false,
    signIn: vi.fn().mockResolvedValue(undefined),
    signUp: vi.fn().mockResolvedValue({ needsConfirmation: false }),
    signInWithGitHub: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

export function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: 0, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });
}

interface RenderOptions {
  route?: string;
  /** When given, `ui` is mounted at this route pattern so `useParams` works. */
  path?: string;
  auth?: AuthContextValue;
  client?: QueryClient;
}

export function renderWithProviders(ui: ReactElement, { route = '/', path, auth = makeAuth(), client = createTestQueryClient() }: RenderOptions = {}): RenderResult & { client: QueryClient } {
  const tree = path ? (
    <Routes>
      <Route path={path} element={ui} />
    </Routes>
  ) : (
    ui
  );
  const result = render(
    <QueryClientProvider client={client}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[route]}>{tree}</MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  );
  return { ...result, client };
}
