import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export interface RunningServer {
  url: string;
  logs: () => string;
  stop: () => Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Starts the compiled API (`dist-e2e/main.js`, built by `pretest:e2e` into its own folder so a
 * running `start:dev` is never disturbed) as a real process on a free port, pointed at the
 * throw-away e2e database, and waits until /api/health is up.
 */
export async function startServer(timeoutMs = 45_000): Promise<RunningServer> {
  const entry = process.env.E2E_SERVER_ENTRY ?? join(process.cwd(), 'dist-e2e', 'main.js');
  if (!existsSync(entry)) throw new Error(`${entry} not found — run \`npm run test:e2e\` (it builds first)`);

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let output = '';
  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), NODE_ENV: 'test', FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`API exited early (code ${child.exitCode}):\n${output}`);
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) break;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (Date.now() >= deadline) {
    child.kill();
    throw new Error(`API did not become healthy within ${timeoutMs} ms:\n${output}`);
  }

  return {
    url,
    logs: () => output,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
