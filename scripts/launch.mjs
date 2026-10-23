import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, ROOT } from '../server/config.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 16)) {
  throw new Error('Node.js 22.16 or newer is required. Use the release folder with its bundled runtime.');
}
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(new URL('../server/index.js', import.meta.url))], {
  cwd: ROOT, stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
});
server.on('exit', (code) => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => server.kill());
process.on('SIGTERM', () => server.kill());
let port;
try {
  port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error('Server startup timed out'));
    }, 10000);
    server.once('error', (err) => { clearTimeout(timer); reject(err); });
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}; port ${config.port} may already be in use.`)); });
    server.on('message', (message) => {
      if (message?.type === 'ready' && Number.isInteger(message.port)) {
        clearTimeout(timer);
        resolve(message.port);
      }
    });
  });
  const health = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
  if (!health.ok || !(await health.json()).ok) throw new Error('Server health check failed');
} catch (err) {
  server.kill();
  throw err;
}
const url = `http://127.0.0.1:${port}`;
console.log(`Ready: ${url}. Keep this window open. Press Ctrl+C to stop.`);
if (process.env.NO_BROWSER !== '1') {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const browser = spawn(command, [url], { stdio: 'ignore' });
  browser.on('error', (err) => console.error(`Could not open the browser: ${err.message}. Open ${url} manually.`));
  browser.on('exit', (code) => {
    if (code) console.error(`Browser launcher exited ${code}. Open ${url} manually.`);
  });
}
