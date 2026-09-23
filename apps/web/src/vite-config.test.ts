// @vitest-environment node

import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import config from '../vite.config';

describe('Vite environment configuration', () => {
  it('loads the shared environment file from the repository root', () => {
    const expectedRoot = fileURLToPath(new URL('../../../', import.meta.url));

    expect(config).toHaveProperty('envDir', expectedRoot);
  });
});
