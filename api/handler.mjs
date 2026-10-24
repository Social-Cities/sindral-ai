// Compile the workspace before Vercel traces this entry point. Node helpers are
// disabled in vercel.json so Fastify receives the original request body.
export { default } from '../apps/server/dist/vercel.js';

export const config = { supportsResponseStreaming: true };
