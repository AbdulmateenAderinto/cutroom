// Development launcher: compiles the main process, starts the Vite dev server for the UI,
// then launches Electron pointed at it. Restart this script after changing src/main or src/preload.
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'vite';
import electronPath from 'electron';

const tsc = spawnSync('npx', ['tsc', '-p', 'tsconfig.main.json'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);

const server = await createServer({ configFile: "vite.config.mts" });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`UI dev server: ${url}`);

const extraArgs = process.argv.slice(2);
const child = spawn(electronPath, ['.', ...extraArgs], {
  stdio: 'inherit',
  env: { ...process.env, CUTROOM_DEV_URL: url },
});
child.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
