// Runs the Vite dev server and launches Electron against it (hot reload for the UI).
import { createServer } from 'vite';
import { spawn } from 'node:child_process';
import electron from 'electron';

const server = await createServer();
await server.listen();
const url = server.resolvedUrls.local[0];
// VS Code terminals export ELECTRON_RUN_AS_NODE=1, which would start Electron as plain Node.
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
delete env.ELECTRON_RUN_AS_NODE;
const app = spawn(electron, ['.'], { stdio: 'inherit', env });
app.on('close', async (code) => { await server.close(); process.exit(code ?? 0); });
