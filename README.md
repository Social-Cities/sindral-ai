# Sindral AI

A Next.js App Router UI for managing software projects and a team of AI coding agents — inboxes, project boards, plan documents, PR diffs, and the chat threads that surround them.

The frontend holds **zero Supabase keys**. All data + auth go through [sindral-ai-backend](../sindral-ai-backend/) (Hono + Supabase).

## Stack

- **Next.js 16** (App Router, Turbopack, React 19, Server Components per view)
- **TypeScript**, no UI framework — handwritten CSS in [app/globals.css](app/globals.css)
- Talks to `sindral-ai-backend` over HTTP. Tokens live in httpOnly cookies set by Server Actions.

## Project layout

```
app/
  page.tsx                        redirect to /inbox
  layout.tsx                      root html + fonts
  (app)/
    layout.tsx                    requireAuth + fetch teammates/humans/projects
    inbox/, my-tasks/, activity/, projects/[projectId]/...
  (auth)/
    login/page.tsx                LoginForm (server action POSTs to backend)
    signup/page.tsx
components/
  app-shell.tsx                   client island: sidebar + topbar + modals
  auth-forms.tsx                  login/signup forms
  providers/people-context.tsx
  ...
lib/
  api.ts                          callAuthed/callPublic + 401-refresh, BACKEND_URL
  session.ts                      access/refresh cookie read/write/clear
  db/types.ts                     domain types (mirrored in backend)
  queries/                        cache()-wrapped server fetchers — call backend
  actions/                        server actions (signIn/Up/Out, createTask)
  data.ts                         UI mappings + type re-exports
  fs.ts                           mock repo filesystem used by the Code tab
supabase/
  migrations/                     schema + RLS — applied via the backend's SQL or manually in Supabase
  seed.sql                        per-user seed lives in 0002_auth_scoping.sql trigger
```

## Setup

### 1. Start the backend

```bash
cd ../sindral-ai-backend
npm install
cp .env.example .env  # fill in SUPABASE_URL / SUPABASE_SECRET_KEY / SUPABASE_PUBLISHABLE_KEY
npm run dev           # serves on :4000
```

The backend's first migration is in this repo at [supabase/migrations/](supabase/migrations/) — apply both `0001_init.sql` and `0002_auth_scoping.sql` to your Supabase project before running the backend.

### 2. Frontend deps + env

```bash
npm install
cp .env.example .env.local
```

The only env var the frontend needs:

```bash
BACKEND_URL=http://localhost:4000
```

No Supabase keys. No `NEXT_PUBLIC_*`. The frontend never touches Supabase directly.

### 3. Run

```bash
npm run dev
```

App boots at [http://localhost:3000](http://localhost:3000). First visit redirects to `/login`; sign up with any email/password and the backend's signup flow triggers `bootstrap_workspace_for_user(uuid)` in Supabase, seeding your demo workspace.

Other scripts:

```bash
npm run build    # production build
npm start
npm test         # vitest unit tests for actions
```

## How data flows

```
[browser]  →  [Next.js (Server Components / Server Actions)]  →  [sindral-ai-backend]  →  [Supabase]
```

- Sign in: `signInAction` POSTs to `/auth/signin` on the backend → backend returns `{ accessToken, refreshToken }` → server action stores both in httpOnly cookies (`sindral_at`, `sindral_rt`).
- Reads: every `lib/queries/*` fetcher calls `callAuthed(...)` which forwards `Authorization: Bearer <accessToken>` to the backend. On a 401, it calls `/auth/refresh` once with the refresh token, persists the rotated pair, and retries.
- Writes: server actions call `callAuthed(...)` and `revalidatePath` so the UI refetches.
- The browser never sees the access token (httpOnly cookie) and never sees a Supabase URL or key.

## Adding a new view

1. Add a route in `sindral-ai-backend/src/routes/...` and wire it in `src/index.ts`.
2. Add a `cache()`-wrapped fetcher in `lib/queries/` that calls `callAuthed("/your/route")`.
3. Create a Server Component page under `app/(app)/...` that awaits the fetcher and passes data into a client view component.
4. If you need mutations, add a backend `POST` route plus a `"use server"` action in `lib/actions/` that calls it and `revalidatePath`s.
