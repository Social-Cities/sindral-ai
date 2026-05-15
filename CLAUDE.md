# Sindral AI — guide for Claude

Next.js 16 App Router app. Frontend-only — all data + auth go through [sindral-ai-backend](../sindral-ai-backend/) over HTTP. The frontend holds **zero Supabase keys**. See [README.md](README.md) for setup; this file is conventions specific to working in the codebase.

## Hard rules

- **Every new feature must ship with tests that pass.** Vitest is wired up — run `npm test`. Add tests under `tests/`. For end-to-end UI flows, install Playwright when the first one is needed.
- **No Supabase access from the frontend.** Do not add `@supabase/*` imports, `NEXT_PUBLIC_SUPABASE_*` env vars, `proxy.ts`, or any direct DB calls. All data flows through `lib/api.ts` → backend HTTP.
- **The user runs Supabase migrations and backend deploys themselves.** Write SQL into [supabase/migrations/](supabase/migrations/) (apply via Supabase dashboard or CLI), and add backend routes in `sindral-ai-backend/src/routes/`. Do not run migrations or call Supabase admin APIs from this repo.
- **Use Server Components per view.** Every page under `app/(app)/` is a Server Component that fetches data via `lib/queries/*` and passes it as props into client components.

## Conventions

### Data flow

- All data lives in `sindral-ai-backend`. Module-level data in `lib/` is forbidden except in [lib/data.ts](lib/data.ts) (UI mappings + type re-exports) and [lib/db/types.ts](lib/db/types.ts) (domain types — mirrored in the backend).
- Reads: add a `cache()`-wrapped fetcher in [lib/queries/](lib/queries/) that calls `callAuthed("/some/path")` from [lib/api.ts](lib/api.ts). The fetcher returns the camelCase domain type; the backend already does the snake_case mapping.
- Writes: add a `"use server"` action in [lib/actions/](lib/actions/), call `callAuthed("/path", { method: "POST", body })`, and `revalidatePath` for affected routes.
- Auth: [lib/api.ts](lib/api.ts) reads/writes the access + refresh cookies via [lib/session.ts](lib/session.ts). On a 401 it auto-refreshes once.

### Client/server split

- The single top-level client island is [components/app-shell.tsx](components/app-shell.tsx).
- View components are `"use client"` because they have local state, but receive all server data via props. They never import from `lib/queries/`, `lib/api.ts`, or `lib/session.ts`.
- People are accessed via [components/providers/people-context.tsx](components/providers/people-context.tsx). The provider is hydrated once in `app/(app)/layout.tsx`.

### Routing

- `(app)/layout.tsx` declares `export const dynamic = "force-dynamic"`. All routes under it render per request.
- New views go under `app/(app)/...`. The pathname is the source of truth for sidebar selection.
- `(auth)/...` holds login/signup. Both layouts call `getCurrentUser()` from `lib/api.ts` to gate access.

### Schema changes

When adding tables/columns:

1. Add a new file `supabase/migrations/000N_<name>.sql` (don't edit existing migrations).
2. Add owner-scoped RLS policies (mirror `auth.uid() = owner_id` in [supabase/migrations/0002_auth_scoping.sql](supabase/migrations/0002_auth_scoping.sql)). For child tables, gate via the parent's `owner_id`.
3. Update [lib/db/types.ts](lib/db/types.ts) AND `sindral-ai-backend/src/types.ts` (keep them in sync).
4. Add the corresponding backend route in `sindral-ai-backend/src/routes/`, then a `cache()`-wrapped query in `lib/queries/` that calls it.

## Commands

```bash
npm run dev      # dev server (frontend, requires backend on BACKEND_URL)
npm run build    # production build
npm test         # vitest
npx tsc --noEmit # typecheck
```

`npm run build` only requires `BACKEND_URL` to be set (placeholder is fine since pages are dynamic — nothing is fetched at build time).
