import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { designFilesSchema, MAX_DESIGN_BYTES, MAX_DESIGN_FILES, MAX_DESIGN_FILE_BYTES, safeDesignPath, type DesignFile } from '@sindral/shared';

const TYPES: Record<string, DesignFile['contentType']> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.md': 'text/markdown', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
};

/** Check and read the same open file, even if its directory entry is replaced. */
async function readDesignFile(file: string, relative: string, remainingBytes: number): Promise<Buffer> {
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const handle = await fs.open(file, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`Unsupported design export: ${relative}`);
    if (stat.size > MAX_DESIGN_FILE_BYTES) throw new Error(`Design export exceeds 1 MB: ${relative}`);
    if (stat.size > remainingBytes) throw new Error('Design bundle exceeds 2.5 MB');
    // A concurrent writer can grow an open file after fstat. Read at most the
    // remaining allowance plus one byte, so growth cannot bypass the limits.
    const limit = Math.min(MAX_DESIGN_FILE_BYTES, remainingBytes);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_DESIGN_FILE_BYTES) throw new Error(`Design export exceeds 1 MB: ${relative}`);
    if (size > remainingBytes) throw new Error('Design bundle exceeds 2.5 MB');
    return Buffer.from(buffer.subarray(0, size));
  } finally {
    await handle.close();
  }
}

export async function collectDesignFiles(root: string): Promise<DesignFile[]> {
  const files: DesignFile[] = [];
  let totalBytes = 0;
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (!safeDesignPath(relative)) throw new Error(`Unsafe design export path: ${relative}`);
      if (entry.isSymbolicLink()) throw new Error(`Design exports cannot contain symlinks: ${relative}`);
      if (entry.isDirectory()) { await walk(full); continue; }
      if (!entry.isFile()) throw new Error(`Unsupported design export: ${relative}`);
      if (files.length >= MAX_DESIGN_FILES) throw new Error('Design bundle exceeds 100 files');
      const bytes = await readDesignFile(full, relative, MAX_DESIGN_BYTES - totalBytes);
      totalBytes += bytes.length;
      const contentType = TYPES[path.extname(entry.name).toLowerCase()] ?? 'text/plain';
      const binary = ['image/png', 'image/jpeg', 'image/webp'].includes(contentType);
      if (!binary && bytes.includes(0)) throw new Error(`Unsupported binary design export: ${relative}`);
      files.push({ path: relative, contentType, encoding: binary ? 'base64' : 'utf8', content: bytes.toString(binary ? 'base64' : 'utf8'), sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  await walk(root);
  return designFilesSchema.parse(files.sort((a, b) => a.path.localeCompare(b.path)));
}

/** Called only with worker-owned empty directories, never a repository checkout. */
export async function restoreDesignFiles(root: string, files: DesignFile[]): Promise<void> {
  designFilesSchema.parse(files);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(root)).isSymbolicLink()) throw new Error('Design workspace cannot be a symlink');
  for (const file of files) {
    const bytes = Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Design file checksum mismatch: ${file.path}`);
    const target = path.join(root, file.path);
    const parts = file.path.split('/');
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      if ((await fs.lstat(parent)).isSymbolicLink()) throw new Error(`Design path contains a symlink: ${file.path}`);
    }
    try { if ((await fs.lstat(target)).isSymbolicLink()) throw new Error(`Design target is a symlink: ${file.path}`); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    await fs.writeFile(target, bytes, { mode: 0o600 });
  }
}
