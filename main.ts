// Entry point: the process that lives between the harness env and this forge.
//
// The env (named by MAKEFUN_ENV_URL) drives the trial. This process only does
// the handshake the env expects, then stays out of the way until the trial is
// over:
//
//   - bind an ephemeral port (the kernel picks one; 8080 belongs to the env),
//   - POST that port to /register so the env can reach this server,
//   - GET /done in a loop until the env reports the trial finished,
//   - shut the server down and exit 0.
//
// Nothing here is scored: the suite exercises the server built by app.ts.
// This file just keeps the conversation with the env alive, retrying
// patiently whenever the env is slow or still starting. It only gives up
// (exit 1) on a contract error from /register, or a failure to bind at all.

import { createApp } from './app.ts';

/** Everything tunable about talking to the env, in one place. */
const ENV = {
  /** Name of the variable that holds the env's origin. */
  varName: 'MAKEFUN_ENV_URL',
  /** How long a single /register or /done request may run before it is dropped and retried. */
  requestTimeoutMs: 30_000,
  /** First pause between retries; the pause doubles each time, up to the cap. */
  retryFirstMs: 250,
  retryMaxMs: 2_000,
} as const;

/** /register answers that mean "done" (200, or 409: a first register already won). */
const REGISTER_DONE = [200, 409];
/** /register answers that mean the contract is wrong: give up at once. */
const REGISTER_FATAL = [400, 405];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The env's origin with trailing slashes removed; exit 1 at once when it is missing. */
function readEnvUrl(): string {
  const url = (process.env[ENV.varName] ?? '').replace(/\/+$/, '');
  if (url === '') {
    process.stderr.write(`[entry] ${ENV.varName} is not set: there is no env to register with\n`);
    process.exit(1);
  }
  return url;
}

/** What one attempt at an env call reports: finished, or try again. */
type AttemptResult = 'done' | 'retry';

/** A client for the env's two endpoints, with the retry loop shared between them. */
class EnvClient {
  private readonly origin: string;

  constructor(origin: string) {
    this.origin = origin;
  }

  /** Pause after the nth failed attempt: 250ms, doubling, capped at 2s. */
  private backoff(attempt: number): number {
    return Math.min(ENV.retryMaxMs, ENV.retryFirstMs * 2 ** Math.min(attempt, 8));
  }

  /**
   * Call `step` until it reports done. A step that throws a fatal error ends
   * the process at once; anything else (a false report, a network failure)
   * waits out the backoff and tries again.
   */
  private async untilDone(step: () => Promise<AttemptResult>): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      if ((await step()) === 'done') return;
      await sleep(this.backoff(attempt));
    }
  }

  /** POST this process's port until the env takes it. Fatal statuses end the run. */
  async register(port: number): Promise<void> {
    await this.untilDone(async () => {
      try {
        const res = await fetch(`${this.origin}/register`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ port }),
          signal: AbortSignal.timeout(ENV.requestTimeoutMs),
        });
        if (REGISTER_DONE.includes(res.status)) return 'done';
        if (REGISTER_FATAL.includes(res.status)) {
          throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
        }
        return 'retry';
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
        return 'retry';
      }
    });
  }

  /** GET /done until the env says the trial is over; never returns early. */
  async waitForDone(): Promise<void> {
    await this.untilDone(async () => {
      try {
        const res = await fetch(`${this.origin}/done`, {
          signal: AbortSignal.timeout(ENV.requestTimeoutMs),
        });
        if (!res.ok) return 'retry';
        const body = (await res.json()) as { done?: unknown };
        return body.done === true ? 'done' : 'retry';
      } catch {
        // Not answering, or the poll timed out: not done yet, so poll again.
        return 'retry';
      }
    });
  }
}

/** Bind, register, wait for done, shut down: the whole life of the process. */
async function main(): Promise<void> {
  const env = new EnvClient(readEnvUrl());
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${address.port}\n`);

  await env.register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await env.waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
