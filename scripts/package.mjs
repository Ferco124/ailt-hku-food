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
for (const name of ['README.md', 'package.json', '.env.example', 'run.bat', 'run.sh']) {
  copyFileSync(join(ROOT, name), join(destination, name));
}
copyFileSync(process.execPath, join(destination, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'));
copyFileSync(license, join(destination, 'runtime', 'LICENSE'));
if (process.platform !== 'win32') {
  chmodSync(join(destination, 'runtime', 'node'), 0o755);
  chmodSync(join(destination, 'run.sh'), 0o755);
}
console.log(`Created ${destination}. Runtime is bundled. No .env, database or query logs were copied. Zip this folder for your OS/architecture.`);
