/**
 * Wire protocol shared by the server and local worker. Bump this only for a
 * breaking worker API change; software versions remain independently reported.
 */
export const WORKER_PROTOCOL_VERSION = 3 as const;
export const WORKER_PROTOCOL_HEADER = 'x-sindral-worker-protocol' as const;
