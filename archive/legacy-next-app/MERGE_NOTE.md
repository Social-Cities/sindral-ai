# Legacy remote application snapshot

This directory preserves the complete `Social-Cities/sindral-ai` tree from commit `18179bb5ec45b81b0bf9bf196d9ef66f75c2f62f`, merged into the production portal history on 2026-09-23.

The remote tree was a separate Next.js frontend designed to call the sibling `sindral-ai-backend` repository. The active repository root is now the pnpm/Fastify/Vite portal described in the root `README.md`. Keeping both applications at the root would make package selection ambiguous, and the legacy `0001`–`0017` migrations would run before and conflict with the active forward-only Supabase schema. For those reasons, the remote application is retained here as reference material and is not included in the active workspace, build, tests, or migration path.

Remote features such as organization management and the user-facing GitHub App connection flow can be ported deliberately from this snapshot into the active architecture without losing their original implementation or Git history.
