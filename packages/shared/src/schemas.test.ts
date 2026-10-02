import { describe, expect, it } from 'vitest';
import { setSecretSchema } from './schemas.js';

describe('setSecretSchema', () => {
  it('trims pasted secret tokens before storage', () => {
    expect(setSecretSchema.parse({ provider: 'github', token: '  ghp_abcdefghijklmnopqrstuvwxyz  \n' })).toEqual({
      provider: 'github',
      token: 'ghp_abcdefghijklmnopqrstuvwxyz',
    });
  });
});
