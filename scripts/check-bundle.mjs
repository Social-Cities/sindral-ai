import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const assetsDir = path.resolve('apps/web/dist/assets');
const limits = {
  routeJs: numberFromEnv('BUNDLE_MAX_ROUTE_GZIP_KB', 20) * 1024,
  vendorJs: numberFromEnv('BUNDLE_MAX_VENDOR_GZIP_KB', 90) * 1024,
  totalJs: numberFromEnv('BUNDLE_MAX_TOTAL_JS_GZIP_KB', 275) * 1024,
  css: numberFromEnv('BUNDLE_MAX_CSS_GZIP_KB', 10) * 1024,
};

let names;
try {
  names = await readdir(assetsDir);
} catch (error) {
  fail(`Web build assets are missing at ${assetsDir}; run pnpm build first`, error);
}

const assets = [];
for (const name of names.sort()) {
  if (!name.endsWith('.js') && !name.endsWith('.css')) continue;
  const bytes = gzipSync(await readFile(path.join(assetsDir, name))).byteLength;
  assets.push({ name, bytes });
}
if (!assets.some((asset) => asset.name.endsWith('.js'))) fail('Web build produced no JavaScript assets');

const violations = [];
let totalJs = 0;
for (const asset of assets) {
  if (asset.name.endsWith('.css')) {
    if (asset.bytes > limits.css) violations.push(`${asset.name}: ${kb(asset.bytes)} KiB > CSS budget ${kb(limits.css)} KiB`);
    continue;
  }
  totalJs += asset.bytes;
  const vendor = asset.name.includes('-vendor-');
  const limit = vendor ? limits.vendorJs : limits.routeJs;
  if (asset.bytes > limit) violations.push(`${asset.name}: ${kb(asset.bytes)} KiB > ${vendor ? 'vendor' : 'route'} budget ${kb(limit)} KiB`);
}
if (totalJs > limits.totalJs) violations.push(`total JavaScript: ${kb(totalJs)} KiB > budget ${kb(limits.totalJs)} KiB`);

for (const asset of assets) process.stdout.write(`${asset.name.padEnd(42)} ${kb(asset.bytes).padStart(7)} KiB gzip\n`);
process.stdout.write(`${'total JavaScript'.padEnd(42)} ${kb(totalJs).padStart(7)} KiB gzip\n`);
if (violations.length > 0) fail(`Bundle budget exceeded:\n- ${violations.join('\n- ')}`);
process.stdout.write('Bundle budget passed\n');

function numberFromEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) fail(`${name} must be a positive number`);
  return parsed;
}

function kb(bytes) {
  return (bytes / 1024).toFixed(2);
}

function fail(message, cause) {
  process.stderr.write(`${message}${cause instanceof Error ? `: ${cause.message}` : ''}\n`);
  process.exit(1);
}
