import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { designFilesSchema, type DesignFile, type DesignResult } from '@sindral/shared';
import { badRequest } from '../errors.js';

export function verifyDesignFiles(files: DesignFile[]): void {
  if (!designFilesSchema.safeParse(files).success) throw badRequest('Invalid design file bundle');
  for (const file of files) {
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw badRequest(`Design checksum mismatch: ${file.path}`);
  }
}

interface PreviewGrant { userId: string; taskId: string; revisionId: string; screen: number; expires: number; input: boolean }
export function designPreviewUrls(key: Buffer, grant: Omit<PreviewGrant, 'screen' | 'expires'>, result: DesignResult): string[] {
  return result.screens.map((_screen, screen) => {
    const payload = Buffer.from(JSON.stringify({ ...grant, screen, expires: Date.now() + 5 * 60_000 })).toString('base64url');
    const signature = createHmac('sha256', key).update(payload).digest('base64url');
    return `/api/design-previews/${grant.taskId}?token=${payload}.${signature}`;
  });
}

export function readPreviewGrant(key: Buffer, token: unknown, taskId: string): PreviewGrant | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) return null;
  const expected = createHmac('sha256', key).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewGrant;
    if (typeof grant.userId !== 'string' || typeof grant.revisionId !== 'string' || grant.taskId !== taskId || !Number.isInteger(grant.screen)
      || grant.screen < 0 || typeof grant.input !== 'boolean' || grant.expires <= Date.now() || grant.expires > Date.now() + 5 * 60_000) return null;
    return grant;
  } catch { return null; }
}

export function designPreviewHtml(result: DesignResult, screenIndex: number): string | null {
  const screen = result.screens[screenIndex];
  const file = screen && result.files.find((item) => item.path === screen.path);
  if (!file) return null;
  if (file.contentType === 'text/html' && file.encoding === 'utf8') return file.content;
  if (!file.contentType.startsWith('image/')) return null;
  const content = file.encoding === 'base64' ? file.content : Buffer.from(file.content).toString('base64');
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;min-height:100%;background:#eee}img{display:block;max-width:100%;height:auto;margin:auto}</style></head><body><img alt="Design preview" src="data:${file.contentType};base64,${content}"></body></html>`;
}

export const DESIGN_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts";
