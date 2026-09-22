import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workerPackage = JSON.parse(await fs.readFile(path.join(root, 'apps/worker/package.json'), 'utf8'));
const version = workerPackage.version;
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('apps/worker/package.json must contain a semantic version');
}

const outputDir = path.resolve(root, process.argv[2] ?? 'release');
const stageParent = await fs.mkdtemp(path.join(os.tmpdir(), 'sindral-worker-release-'));
const stage = path.join(stageParent, 'package');
try {
  run('pnpm', ['--filter', '@sindral/worker', 'deploy', '--prod', '--legacy', stage]);
  for (const entry of await fs.readdir(stage)) {
    if (!new Set(['dist', 'node_modules', 'package.json', 'README.md']).has(entry)) {
      await fs.rm(path.join(stage, entry), { recursive: true, force: true });
    }
  }

  const cli = path.join(stage, 'dist/cli.js');
  await fs.access(cli);
  const versionCheck = run(process.execPath, [cli, '--version'], { cwd: stage, capture: true });
  if (versionCheck.stdout.trim() !== version) throw new Error(`packaged worker reported ${JSON.stringify(versionCheck.stdout.trim())}, expected ${version}`);

  await fs.mkdir(outputDir, { recursive: true });
  const baseName = `sindral-worker-${version}-${process.platform}-${process.arch}`;
  const archive = path.join(outputDir, `${baseName}.tar.gz`);
  run('tar', ['-czf', archive, '-C', stage, '.']);
  const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const checksum = `${archive}.sha256`;
  await fs.writeFile(checksum, `${digest}  ${path.basename(archive)}\n`);
  process.stdout.write(`${path.relative(root, archive)}\n${path.relative(root, checksum)}\n`);
} finally {
  await fs.rm(stageParent, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}${result.stderr ? `: ${result.stderr.trim()}` : ''}`);
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
