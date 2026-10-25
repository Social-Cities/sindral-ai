import { z } from 'zod';

export const DESIGN_SESSION_KEY = 'design';
export const MAX_DESIGN_FILES = 100;
export const MAX_DESIGN_BYTES = 2_500_000;
export const MAX_DESIGN_FILE_BYTES = 1_000_000;

/** Paths are portable, relative to the design workspace, and never configuration files. */
export function safeDesignPath(value: string): boolean {
  return value.length > 0 && value.length <= 240 && !value.includes('\\') && !value.includes(':') && ![...value].some((character) => character.charCodeAt(0) < 32)
    && value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..' && !part.startsWith('.') && part !== 'node_modules');
}

export const designFileSchema = z.object({
  path: z.string().refine(safeDesignPath, 'Expected a safe relative design path'),
  contentType: z.enum(['text/html', 'text/css', 'text/javascript', 'text/plain', 'text/markdown', 'application/json', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/webp']),
  encoding: z.enum(['utf8', 'base64']),
  content: z.string().max(1_400_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type DesignFile = z.infer<typeof designFileSchema>;

export const designFilesSchema = z.array(designFileSchema).max(MAX_DESIGN_FILES).superRefine((files, ctx) => {
  let size = 0;
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) ctx.addIssue({ code: 'custom', message: `Duplicate design path: ${file.path}` });
    paths.add(file.path);
    if (file.encoding === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)) {
      ctx.addIssue({ code: 'custom', message: `Invalid base64: ${file.path}` });
    }
    const bytes = file.encoding === 'utf8' ? new TextEncoder().encode(file.content).byteLength
      : file.content.length * 3 / 4 - (file.content.endsWith('==') ? 2 : file.content.endsWith('=') ? 1 : 0);
    if (bytes > MAX_DESIGN_FILE_BYTES) ctx.addIssue({ code: 'custom', message: `Design file exceeds 1 MB: ${file.path}` });
    size += bytes;
  }
  if (size > MAX_DESIGN_BYTES) ctx.addIssue({ code: 'custom', message: 'Design bundle exceeds 2.5 MB' });
  if (new TextEncoder().encode(JSON.stringify(files)).byteLength > 3_500_000) ctx.addIssue({ code: 'custom', message: 'Encoded design bundle exceeds 3.5 MB' });
});

export const claudeDesignUrlSchema = z.string().url().max(2000).refine((value) => {
  const url = new URL(value);
  return url.protocol === 'https:' && url.hostname === 'claude.ai' && !url.username && !url.password
    && (url.pathname.startsWith('/code/artifact/') || url.pathname.startsWith('/artifacts/') || url.pathname.startsWith('/design/'));
}, 'Expected a Claude artifact URL');

export const designResultSchema = z.object({
  kind: z.literal('design'),
  summary: z.string().trim().min(1).max(20_000),
  designUrl: claudeDesignUrlSchema.nullable().default(null),
  specification: z.string().max(100_000),
  questions: z.array(z.string().min(1).max(2000)).max(20).default([]),
  screens: z.array(z.object({ name: z.string().min(1).max(200), path: z.string().refine(safeDesignPath) })).max(30),
  files: designFilesSchema,
  outcome: z.string().trim().min(1).max(20_000).optional(),
  acceptanceCriteria: z.string().trim().min(1).max(50_000).optional(),
}).superRefine((result, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 3_800_000) ctx.addIssue({ code: 'custom', message: 'Design result exceeds the transfer limit' });
  if (!result.screens.length) {
    if (!result.questions.length || result.designUrl || result.files.length) ctx.addIssue({ code: 'custom', message: 'A clarification turn requires questions and no design URL, files, or screens' });
  } else if (!result.specification.trim()) ctx.addIssue({ code: 'custom', message: 'A design requires exported screens and an implementation specification' });
  for (const screen of result.screens) {
    const file = result.files.find((item) => item.path === screen.path);
    if (!file || !['text/html', 'image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.contentType)) {
      ctx.addIssue({ code: 'custom', message: `Missing preview file: ${screen.path}` });
    }
  }
});
export type DesignResult = z.infer<typeof designResultSchema>;

export interface DesignRevision {
  id: string;
  taskId: string;
  jobId: string;
  result: DesignResult;
  createdAt: string;
  approvedAt: string | null;
}
export type DesignRevisionSummary = Omit<DesignRevision, 'result'> & Pick<DesignResult, 'summary' | 'designUrl' | 'screens'>;

/** Stored separately from the source task so deleting it cannot break an implementation. */
export interface DesignHandoff {
  sourceTaskId: string;
  revisionId: string;
  approvedAt: string;
  result: DesignResult;
}

export interface DesignOverview {
  revisions: DesignRevisionSummary[];
  checkpointAt: string | null;
  input: DesignHandoff | null;
  inputPreviewUrls: string[];
}
export interface DesignRevisionView { revision: DesignRevision; previewUrls: string[] }

export interface PortableSessionKey {
  projectKey: string;
  sessionId: string;
  subpath?: string;
}
export interface PortableSessionEntry { type: string; [key: string]: unknown }
export interface DesignCheckpoint {
  sessionId: string | null;
  files: DesignFile[];
  updatedAt: string;
}

const leaseFields = { attempt: z.number().int().positive(), leaseToken: z.string().uuid() };
export const sessionAccessSchema = z.object(leaseFields);
export const portableSessionKeySchema = z.object({
  projectKey: z.string().min(1).max(240).regex(/^[A-Za-z0-9_-]+$/),
  sessionId: z.string().uuid(),
  // SDK sidecar suffixes are opaque, including file extensions. Do not flatten or rewrite them.
  subpath: z.string().min(1).max(240).refine((value) => !value.includes('\\') && !value.includes(':')
    && value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
    && ![...value].some((character) => character.charCodeAt(0) < 32)).optional(),
});
export const sessionLoadSchema = sessionAccessSchema.extend({ key: portableSessionKeySchema, after: z.number().int().nonnegative().default(0) });
export const sessionAppendSchema = sessionAccessSchema.extend({
  key: portableSessionKeySchema,
  entries: z.array(z.object({ type: z.string().min(1).max(100) }).catchall(z.unknown())).min(1).max(100),
}).refine((value) => new TextEncoder().encode(JSON.stringify(value.entries)).byteLength <= 2_500_000, 'Transcript batch exceeds 2.5 MB');
export const sessionCheckpointSchema = sessionAccessSchema.extend({ sessionId: z.string().uuid().nullable(), files: designFilesSchema });
export const approveDesignSchema = z.object({ revisionId: z.string().uuid(), expectedVersion: z.number().int().nonnegative() });
