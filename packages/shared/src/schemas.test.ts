import { describe, expect, it } from 'vitest';
import { setSecretSchema } from './schemas.js';

describe('setSecretSchema', () => {
  it('trims pasted secret tokens before storage', () => {
    const token = ['ghp', 'abcdefghijklmnopqrstuvwxyz'].join('_');
    expect(setSecretSchema.parse({ provider: 'github', token: `  ${token}  \n` })).toEqual({
      provider: 'github',
      token,
    });
  });
});
