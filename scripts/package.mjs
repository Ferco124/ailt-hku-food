import { cpSync, mkdirSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ROOT } from '../server/config.js';

const destination = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, 'dist', `hku-food-${process.platform}-${process.arch}`);
if (existsSync(destination)) throw new Error(`Release folder already exists: ${destination}. Move it aside before packaging again.`);
const license = join(dirname(process.execPath), 'LICENSE');
if (!existsSync(license)) throw new Error('Node redistribution requires its LICENSE beside the runtime. Use an official Node distribution.');
mkdirSync(join(destination, 'runtime'), { recursive: true });
for (const name of ['server', 'public', 'scripts', 'docs', '.github', 'tests']) {
  cpSync(join(ROOT, name), join(destination, name), { recursive: true });
}
mkdirSync(join(destination, 'data'), { recursive: true });
for (const name of ['canteens.json', 'vocab.json', 'coverage.json', 'walkthrough.json']) {
  copyFileSync(join(ROOT, 'data', name), join(destination, 'data', name));
}
for (const name of ['README.md', 'package.json', '.env.example', 'run.bat', 'run.sh', 'run.command']) {
  copyFileSync(join(ROOT, name), join(destination, name));
}
copyFileSync(process.execPath, join(destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
copyFileSync(license, join(destination, 'runtime', 'LICENSE'));
// Set the mode on every platform: a ZIP written on Windows records Unix mode 0,
// which strips the executable bit and makes `./run.sh` fail with "permission denied".
for (const name of ['runtime/node', 'run.sh', 'run.command']) {
  chmodSync(join(destination, name), 0o755);
}
console.log(`Created ${destination}. Runtime is bundled. No .env, database or query logs were copied.`);
console.log('Ship macOS/Linux builds as .tar.gz (tar keeps the executable bit); ZIP strips it.');
