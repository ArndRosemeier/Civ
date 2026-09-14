import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';

const result = win
  ? spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'deploy-sync.ps1')],
      { stdio: 'inherit', cwd: root, env: process.env },
    )
  : spawnSync('bash', [path.join(root, 'deploy-sync.sh')], {
      stdio: 'inherit',
      cwd: root,
      env: process.env,
    });

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
