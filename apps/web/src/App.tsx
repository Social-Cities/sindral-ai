import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { AuthProvider, useAuth } from '@/auth/AuthProvider';
import { Layout } from '@/components/Layout';
import { PageLoader } from '@/components/Spinner';
import { useServerEvents } from '@/hooks/useServerEvents';
import { ApiError } from '@/lib/api';
import { Home } from '@/pages/Home';
import { Login } from '@/pages/Login';
import { Settings } from '@/pages/Settings';
import { TaskDetail } from '@/pages/TaskDetail';
import { Tasks } from '@/pages/Tasks';
import { Workflows } from '@/pages/Workflows';

export function createAppQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
          return count < 2;
        },
        refetchOnWindowFocus: true,
      },
    },
  });
}

/** Authenticated shell: redirects to /login, mounts the SSE subscription and the layout. */
function Protected() {
  const { session, loading } = useAuth();
  const location = useLocation();
  const liveStatus = useServerEvents(!!session);

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <PageLoader label="Signing in…" />
      </div>
    );
  }
  if (!session) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;

  return (
    <Layout liveStatus={liveStatus}>
      <Outlet />
    </Layout>
  );
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<Protected />}>
        <Route path="/" element={<Home />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskDetail />} />
        <Route path="/workflows" element={<Workflows />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  const [client] = useState(createAppQueryClient);
  return (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}
