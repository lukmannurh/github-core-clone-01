// HTTP server: routing, auth, request ids, JSON discipline. The git and REST handlers do the work;
// this file only moves bytes. Every reply carries a non-empty X-GitHub-Request-Id (a deterministic
// counter, so nothing wall-clock-derived ever enters a response header).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { Store, VIEWER } from './store.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createApp(): Server {
  const store = new Store();
  let requestSeq = 0;

  const sendJson = (res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
    const payload = body === null ? '' : Buffer.from(JSON.stringify(body), 'utf8');
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': payload.length,
      'x-github-request-id': `req-${++requestSeq}`,
      ...extraHeaders,
    });
    res.end(payload);
  };

  const sendRaw = (res: ServerResponse, status: number, contentType: string, body: Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'content-length': body.length,
      'x-github-request-id': `req-${++requestSeq}`,
    });
    res.end(body);
  };

  const readBody = (req: IncomingMessage): Promise<Buffer> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          reject(new Error('request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const segments = url.pathname
          .split('/')
          .filter((segment) => segment !== '')
          .map((segment) => {
            try {
              return decodeURIComponent(segment);
            } catch {
              return segment;
            }
          });
        const method = req.method ?? 'GET';

        // Health probe: no auth, no JSON shape beyond {"ok":true}.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const isApi = segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3';
        const isGit = segments.length >= 3 && (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack');

        if (isApi) {
          // REST: a bearer token is required; any non-empty bearer is the viewer (the shop token
          // is opaque and the scenario fixes the viewer). No token -> 401 JSON.
          const auth = req.headers.authorization ?? '';
          if (!/^Bearer\s+\S+$/.test(auth)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          let parsed: unknown = null;
          if (rawBody.length > 0) {
            try {
              parsed = JSON.parse(rawBody.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'malformed JSON body' });
              return;
            }
          }
          const restReq: RestRequest = {
            method,
            segments,
            query: url.searchParams,
            body: parsed,
            origin: `http://${req.headers.host ?? '127.0.0.1'}`,
          };
          const out = handleRest(store, restReq);
          sendJson(res, out.status, out.body, out.headers);
          return;
        }

        const isGraphql = segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql';
        const isMcp = segments.length === 1 && segments[0] === 'mcp';

        if (isGraphql || isMcp) {
          // GraphQL + MCP: same bearer rule as REST (any non-empty bearer is the viewer).
          // No token -> 401 JSON, exactly what both conformance clients expect.
          const auth = req.headers.authorization ?? '';
          if (!/^Bearer\s+\S+$/.test(auth)) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          const rawBody = await readBody(req);
          if (isGraphql) {
            const out = handleGraphQL(store, rawBody.toString('utf8'));
            sendJson(res, out.status, out.body);
            return;
          }
          const out = handleMcp(store, rawBody.toString('utf8'));
          if (out.body === '') {
            res.writeHead(out.status, { 'content-type': 'application/json', 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, out.status, out.body);
          return;
        }

        if (isGit) {
          const owner = segments[0];
          // Git URLs carry a ".git" suffix on the repo segment (/{owner}/{repo}.git/...).
          const repoName = segments[1].replace(/\.git$/, '');
          const repo = owner === VIEWER.login ? store.getRepo(repoName) : undefined;
          if (segments[2] === 'info' && segments[3] === 'refs' && segments.length === 4 && method === 'GET') {
            const service = url.searchParams.get('service') ?? '';
            const out = handleInfoRefs(store, repo, service, req.headers['git-protocol'] ?? '');
            if (out.status === 200) sendRaw(res, 200, out.contentType, out.body);
            else sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
            return;
          }
          if (segments[2] === 'git-upload-pack' && segments.length === 3 && method === 'POST') {
            const body = await readBody(req);
            const out = handleUploadPack(store, repo, req.headers['git-protocol'] ?? '', body);
            if (out.status === 200) sendRaw(res, 200, out.contentType, out.body);
            else sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
            return;
          }
          if (segments[2] === 'git-receive-pack' && segments.length === 3 && method === 'POST') {
            const body = await readBody(req);
            const out = handleReceivePack(store, repo, body);
            if (out.status === 200) sendRaw(res, 200, out.contentType, out.body);
            else sendJson(res, out.status, JSON.parse(out.body.toString('utf8')));
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (error) {
        // A handler failure must never kill the server (repo-survives-errors proves it stays up).
        try {
          sendJson(res, 500, { message: error instanceof Error ? error.message : 'internal error' });
        } catch {
          // The response may already be gone; nothing more to do.
        }
      }
    })();
  });
}
