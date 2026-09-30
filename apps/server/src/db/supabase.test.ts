import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { EXPECTED_SCHEMA_VERSION, SupabaseRepository } from './supabase.js';

describe('SupabaseRepository startup compatibility', () => {
  it('accepts the exact schema version', async () => {
    expect(EXPECTED_SCHEMA_VERSION).toBe('20260930153931');
    const rpc = vi.fn().mockResolvedValue({ data: EXPECTED_SCHEMA_VERSION, error: null });
    const repo = new SupabaseRepository({ rpc } as unknown as SupabaseClient);
    await expect(repo.assertCompatibleSchema()).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledWith('sindral_schema_version');
  });

  it('rejects missing migrations and connectivity failures', async () => {
    const stale = new SupabaseRepository({ rpc: vi.fn().mockResolvedValue({ data: '20260921000000', error: null }) } as unknown as SupabaseClient);
    await expect(stale.assertCompatibleSchema()).rejects.toThrow(/incompatible.*Apply all Supabase migrations/);

    const unavailable = new SupabaseRepository({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'connection refused', code: '08006' } }) } as unknown as SupabaseClient);
    await expect(unavailable.assertCompatibleSchema()).rejects.toMatchObject({ name: 'RepositoryError', code: '08006' });
  });
});
