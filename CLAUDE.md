# Sindral AI — agent notes

pnpm monorepo. `packages/shared` is the contract (types, state machine, schemas); `apps/server` (Fastify), `apps/web` (React/Vite), `apps/worker` (Node daemon). Supabase migrations live in `supabase/migrations`.

- Build shared first: `pnpm --filter @sindral/shared build` (apps import `@sindral/shared` from `dist`).
- Verify with `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- Strict TS, ESM with `.js` import extensions, `import type` for types, no `any`.
- All state transitions go through `transition()` in `packages/shared/src/stateMachine.ts`; never mutate task state ad hoc.
- Every server query is scoped by the authenticated user id. Never log secrets.
- The design reference is `../sindral-ai-design`; product requirements are `../sindral-ai-engineering.md`.
