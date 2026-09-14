/**
 * Cross-platform owner of `pnpm check:static` / `check:static:full`.
 *
 * The three checks are independent, so they run as concurrent processes and the
 * step fails if any of them fails. This used to be a bash `wait $!` one-liner in
 * package.json; cmd.exe on Windows treats `t=$!` as a command named `t`.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const full = process.argv.includes('--full');
const ALLOWED = new Set(['typecheck', 'lint', 'format:check', 'lint:full', 'format:check:full']);
const checks = full
  ? ['typecheck', 'lint:full', 'format:check:full']
  : ['typecheck', 'lint', 'format:check'];

for (const script of checks) {
  if (!ALLOWED.has(script)) {
    throw new Error(`unknown check: ${script}`);
  }
}

function run(script) {
  return new Promise((resolve) => {
    // Node 20+ rejects spawning a `.cmd` shim without a shell (`EINVAL`). Passing
    // the whole command as one string avoids DEP0190 (argv is not escaped when
    // `shell: true`). `script` is from ALLOWED, not user input.
    const child = spawn(`pnpm run ${script}`, {
      stdio: 'inherit',
      cwd: root,
      env: process.env,
      shell: true,
    });
    child.on('error', (err) => {
      console.error(err.message);
      resolve({ script, code: 1 });
    });
    child.on('exit', (code) => {
      resolve({ script, code: code === null ? 1 : code });
    });
  });
}

const results = await Promise.all(checks.map(run));
const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  for (const result of failed) {
    console.error(`${result.script} failed with exit code ${result.code}`);
  }
  process.exit(1);
}
