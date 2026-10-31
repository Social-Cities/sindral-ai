# Sindral AI — agent notes

pnpm monorepo. `packages/shared` is the contract (types, state machine, schemas); `apps/server` (Fastify), `apps/web` (React/Vite), `apps/worker` (Node daemon). Supabase migrations live in `supabase/migrations`.

- Build shared first: `pnpm --filter @sindral/shared build` (apps import `@sindral/shared` from `dist`).
- Verify with `pnpm typecheck && pnpm test && pnpm lint && pnpm build`.
- Strict TS, ESM with `.js` import extensions, `import type` for types, no `any`.
- Hard rule: never create, edit, rename, or delete GitHub Actions workflow files under `.github/workflows/`.
- Use Domain Driven Design for new and changed code: explicit bounded contexts, framework-independent domain rules and invariants, application use cases, and infrastructure adapters. Keep UI and Supabase SDK access outside domain logic; test business invariants in isolation and avoid unrelated architecture rewrites. See `docs/operations/domain-driven-design.md`.
- All state transitions go through `transition()` in `packages/shared/src/stateMachine.ts`; never mutate task state ad hoc.
- Every server query is scoped by the authenticated user id. Never log secrets.
- The design reference is `../sindral-ai-design`; product requirements are `../sindral-ai-engineering.md`.
