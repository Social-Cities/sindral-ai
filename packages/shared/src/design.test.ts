import { describe, expect, it } from 'vitest';
import { designResultSchema } from './design.js';

const design = {
  kind: 'design', summary: 'Dashboard prototype', designUrl: null,
  specification: 'Responsive dashboard with keyboard-accessible navigation.',
  questions: [], screens: [{ name: 'Dashboard', path: 'index.html' }],
  files: [{ path: 'index.html', contentType: 'text/html', encoding: 'utf8', content: '<h1>Dashboard</h1>', sha256: 'a'.repeat(64) }],
};

describe('design result contract', () => {
  it('accepts preview files with no hosted artifact and defaults an omitted URL', () => {
    expect(designResultSchema.parse(design).designUrl).toBeNull();
    const { designUrl: _url, ...withoutUrl } = design;
    expect(designResultSchema.parse(withoutUrl).designUrl).toBeNull();
  });

  it('retains support for earlier Claude artifact links', () => {
    expect(designResultSchema.safeParse({ ...design, designUrl: 'https://claude.ai/code/artifact/existing' }).success).toBe(true);
    expect(designResultSchema.safeParse({ ...design, designUrl: 'https://example.com/untrusted' }).success).toBe(false);
  });

  it('requires an implementation specification and the actual screen files', () => {
    expect(designResultSchema.safeParse({ ...design, specification: ' ' }).success).toBe(false);
    expect(designResultSchema.safeParse({ ...design, files: [] }).success).toBe(false);
    expect(designResultSchema.safeParse({ ...design, screens: [{ name: 'Missing', path: 'missing.html' }] }).success).toBe(false);
  });

  it('distinguishes clarification turns from completed designs by their screens', () => {
    const clarification = { ...design, specification: '', questions: ['Who uses the dashboard?'], screens: [], files: [] };
    expect(designResultSchema.safeParse(clarification).success).toBe(true);
    expect(designResultSchema.safeParse({ ...clarification, questions: [] }).success).toBe(false);
    expect(designResultSchema.safeParse({ ...clarification, files: design.files }).success).toBe(false);
    expect(designResultSchema.safeParse({ ...clarification, designUrl: 'https://claude.ai/design/existing' }).success).toBe(false);
  });
});
