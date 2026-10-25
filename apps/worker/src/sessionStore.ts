import type { SessionKey, SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import type { ApiClient } from './api.js';

/** A task-scoped capability; the server derives task ownership from the leased job. */
export class WorkerSessionStore implements SessionStore {
  private pending: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(private readonly api: Pick<ApiClient, 'loadSession' | 'appendSession'>,
    private readonly jobId: string, private readonly access: { attempt: number; leaseToken: string }, private readonly onFailure: (err: Error) => void) {}

  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    this.pending = this.pending.then(async () => {
      let batch: SessionStoreEntry[] = [];
      let size = 0;
      for (const entry of entries) {
        const bytes = Buffer.byteLength(JSON.stringify(entry));
        if (bytes > 2_000_000) throw new Error('A Claude transcript entry exceeds the portable session limit');
        if (batch.length >= 100 || size + bytes > 2_100_000) { await this.api.appendSession(this.jobId, { ...this.access, key, entries: batch }); batch = []; size = 0; }
        batch.push(entry); size += bytes;
      }
      if (batch.length) await this.api.appendSession(this.jobId, { ...this.access, key, entries: batch });
    }).catch((error: unknown) => {
      this.failure = error instanceof Error ? error : new Error(String(error));
      this.onFailure(this.failure);
      throw this.failure;
    });
    return this.pending;
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const entries: SessionStoreEntry[] = [];
    let after: number | null = 0;
    while (after !== null) {
      const page = await this.api.loadSession(this.jobId, { ...this.access, key, after });
      entries.push(...page.entries);
      if (page.nextAfter === null) break;
      if (page.nextAfter <= after) throw new Error('Invalid portable session pagination');
      after = page.nextAfter;
    }
    return entries.length ? entries : null;
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    return (await this.api.loadSession(this.jobId, { ...this.access, key, after: 0 })).subkeys;
  }

  async flush(): Promise<void> {
    await this.pending;
    if (this.failure) throw this.failure;
  }
}
