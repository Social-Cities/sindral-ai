import type { DesignCheckpoint, DesignFile, PortableSessionEntry, PortableSessionKey } from '@sindral/shared';

export type DesignSessionCommand =
  | { operation: 'read' }
  | { operation: 'load'; key: PortableSessionKey; after: number }
  | { operation: 'append'; key: PortableSessionKey; entries: PortableSessionEntry[] }
  | { operation: 'checkpoint'; sessionId: string | null; files: DesignFile[] };

export interface DesignSessionResponse {
  checkpoint?: DesignCheckpoint | null;
  entries?: PortableSessionEntry[];
  nextAfter?: number | null;
  subkeys?: string[];
}

export interface SessionAccess { attempt: number; leaseToken: string }
