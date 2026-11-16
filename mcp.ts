// MCP surface (phase 3): a JSON-RPC 2.0 server over Streamable HTTP at POST /mcp, speaking the
// modern (2026-07-28) era — server/discover first, legacy initialize as a fallback — and the same
// in-memory store as REST, so a tool result and a REST read of the same object always agree.
// Six tools: create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request. No wall clock anywhere: ids are the store's deterministic numbers.

import {
  issueNumericId,
  pullNumericId,
  repoNumericId,
  RestError,
  VIEWER,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as JsonRecord;
  return null;
}

function textPart(text: string): { type: string; text: string } {
  return { type: 'text', text };
}

function errorResult(message: string): JsonRecord {
  return { content: [textPart(message)], isError: true };
}

/** The six tools, in a fixed order: tools/list must answer byte-identical lists. */
const TOOLS: JsonRecord[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The public shapes tools return (same ids as REST, so REST and MCP agree). */
function repoObject(repo: Repo): JsonRecord {
  return {
    id: repoNumericId(repo),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueObject(repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issueNumericId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
  };
}

function pullObject(repo: Repo, pull: PullRequest): JsonRecord {
  return {
    id: pullNumericId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    head: pull.headRef,
    base: pull.baseRef,
  };
}

/** Find a repo the viewer owns; null when the owner is not the viewer or the repo is missing. */
function findRepo(store: Store, owner: unknown, repoName: unknown): Repo | null {
  if (owner !== VIEWER.login || typeof repoName !== 'string') return null;
  return store.getRepo(repoName) ?? null;
}

/** The first required property that is missing (undefined or null) from the arguments. */
function missingRequired(args: JsonRecord, required: string[]): string | null {
  for (const name of required) {
    if (args[name] === undefined || args[name] === null) return name;
  }
  return null;
}

/** Run one tool call against the store. Errors become isError results, never HTTP 500s. */
function callTool(store: Store, name: string, args: JsonRecord): JsonRecord {
  if (name === 'create_repo') {
    const missing = missingRequired(args, ['name']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repoName = String(args.name);
    if (store.getRepo(repoName) !== undefined) return errorResult(`repository ${repoName} already exists`);
    const repo = store.createRepo(
      repoName,
      typeof args.description === 'string' ? args.description : '',
      args.private === true,
    );
    const obj = repoObject(repo);
    return { content: [textPart(JSON.stringify(obj))], structuredContent: obj };
  }

  if (name === 'get_repo') {
    const missing = missingRequired(args, ['owner', 'repo']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repo = findRepo(store, args.owner, args.repo);
    if (repo === null) return errorResult('Not Found');
    const obj = repoObject(repo);
    return { content: [textPart(JSON.stringify(obj))], structuredContent: obj };
  }

  if (name === 'create_issue') {
    const missing = missingRequired(args, ['owner', 'repo', 'title']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repo = findRepo(store, args.owner, args.repo);
    if (repo === null) return errorResult('Not Found');
    const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
    const obj = issueObject(repo, issue);
    return { content: [textPart(JSON.stringify(obj))], structuredContent: obj };
  }

  if (name === 'list_issues') {
    const missing = missingRequired(args, ['owner', 'repo']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repo = findRepo(store, args.owner, args.repo);
    if (repo === null) return errorResult('Not Found');
    const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
    const list = [...repo.issues.values()].filter((issue) => state === 'all' || issue.state === state);
    const objects = list.map((issue) => issueObject(repo, issue));
    return { content: [textPart(JSON.stringify(objects))], structuredContent: { issues: objects } };
  }

  if (name === 'create_pull_request') {
    const missing = missingRequired(args, ['owner', 'repo', 'title', 'head', 'base']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repo = findRepo(store, args.owner, args.repo);
    if (repo === null) return errorResult('Not Found');
    let pull: PullRequest;
    try {
      pull = store.createPull(
        repo,
        String(args.head),
        String(args.base),
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
      );
    } catch (err) {
      if (err instanceof RestError) return errorResult(err.message);
      throw err;
    }
    const obj = pullObject(repo, pull);
    return { content: [textPart(JSON.stringify(obj))], structuredContent: obj };
  }

  if (name === 'merge_pull_request') {
    const missing = missingRequired(args, ['owner', 'repo', 'pull_number']);
    if (missing !== null) return errorResult(`Missing required argument: ${missing}`);
    const repo = findRepo(store, args.owner, args.repo);
    if (repo === null) return errorResult('Not Found');
    const number = Number(args.pull_number);
    if (!Number.isFinite(number)) return errorResult('pull_number must be a number');
    let pull: PullRequest | undefined;
    try {
      store.mergePull(repo, number);
      pull = store.getPull(repo, number);
    } catch (err) {
      if (err instanceof RestError) return errorResult(err.message);
      throw err;
    }
    if (pull === undefined) return errorResult('Not Found');
    const obj = pullObject(repo, pull);
    return { content: [textPart(JSON.stringify(obj))], structuredContent: obj };
  }

  return { error: { code: -32602, message: `Unknown tool: ${name}` } };
}

/**
 * Handle POST /mcp (JSON-RPC 2.0 over Streamable HTTP). Callers must already have authenticated.
 * Returns a status + a JSON body, or status 202 with an empty body for notifications.
 */
export function handleMcp(store: Store, rawBody: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = asRecord(parsed);
  if (request === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const id: unknown = 'id' in request ? request.id : null;
  const method = typeof request.method === 'string' ? request.method : '';
  if (method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }
  const params = asRecord(request.params) ?? {};
  const ok = (result: unknown): { status: number; body: unknown } => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const fail = (code: number, message: string): { status: number; body: unknown } => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return ok({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return ok({
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return ok({ tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = asRecord(params.arguments) ?? {};
    if (name === '') return fail(-32602, 'tools/call requires a tool name');
    const outcome = callTool(store, name, args);
    if ('error' in outcome) {
      const error = outcome.error as { code: number; message: string };
      return fail(error.code, error.message);
    }
    return ok(outcome);
  }

  return fail(-32601, `Method not found: ${method}`);
}
