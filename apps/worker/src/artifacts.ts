import fs from 'node:fs/promises';
import path from 'node:path';
import { ARTIFACT_CONTENT_TYPES, MAX_ARTIFACT_BYTES } from '@sindral/shared';

export interface ArtifactFile {
  name: string;
  contentType: string;
  content: string;
}

export { MAX_ARTIFACT_BYTES };
export const MAX_ARTIFACTS = 50;

const CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.mmd': 'text/plain',
  '.log': 'text/plain',
};

export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? 'text/plain';
}

/** Artifact names cannot contain path separators; nested paths are flattened. */
export function artifactName(relPath: string): string {
  return relPath.split(/[\\/]+/).filter(Boolean).join('__').slice(0, 200);
}

export function isBinary(buf: Buffer): boolean {
  const sample = buf.subarray(0, 8000);
  return sample.includes(0);
}

/** Collects regular text files under `dir` (recursively) as artifacts. */
export async function collectOutputArtifacts(dir: string, maxBytes: number = MAX_ARTIFACT_BYTES): Promise<ArtifactFile[]> {
  const out: ArtifactFile[] = [];
  await walk(dir, dir, out, maxBytes);
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function walk(root: string, dir: string, out: ArtifactFile[], maxBytes: number): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      await walk(root, full, out, maxBytes);
      continue;
    }
    if (!entry.isFile()) continue;
    const stat = await fs.stat(full);
    if (stat.size === 0 || stat.size > maxBytes) continue;
    const buf = await fs.readFile(full);
    if (isBinary(buf)) continue;
    out.push({ name: artifactName(path.relative(root, full)), contentType: contentTypeFor(entry.name), content: buf.toString('utf8') });
  }
}

/** Result-declared artifacts win over same-named files from the output dir. */
export function mergeArtifacts(declared: unknown, collected: ArtifactFile[], limit: number = MAX_ARTIFACTS): ArtifactFile[] {
  const merged: ArtifactFile[] = [];
  const seen = new Set<string>();
  const declaredList = Array.isArray(declared) ? declared : [];
  for (const item of declaredList) {
    if (!item || typeof item !== 'object') continue;
    const a = item as Record<string, unknown>;
    if (typeof a['name'] !== 'string' || typeof a['content'] !== 'string') continue;
    const name = artifactName(a['name']);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const declaredType = typeof a['contentType'] === 'string' ? a['contentType'] : '';
    const contentType = ARTIFACT_CONTENT_TYPES.includes(declaredType as (typeof ARTIFACT_CONTENT_TYPES)[number])
      ? declaredType
      : contentTypeFor(name);
    merged.push({ name, contentType, content: a['content'] });
  }
  for (const file of collected) {
    if (seen.has(file.name)) continue;
    seen.add(file.name);
    merged.push(file);
  }
  return merged.slice(0, limit);
}
