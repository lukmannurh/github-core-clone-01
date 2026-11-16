// REST v3 surface (phase 1: repos + contents + branches + commits; phase 2: labels + issues + pulls).
// Every reply is JSON with a non-empty X-GitHub-Request-Id (set by app.ts); unknown routes are
// JSON 404s; malformed JSON bodies are 400s; a missing bearer token is a 401; any owner other
// than the viewer is a 404, never a 403.
import { parseCommit } from './git.ts';
import {
  deterministicIso,
  issueNumericId,
  pullNumericId,
  repoNumericId,
  RestError,
  VIEWER,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestRequest {
  readonly method: string;
  /** Decoded path segments (no leading/trailing empty segments). */
  readonly segments: string[];
  readonly query: URLSearchParams;
  /** Parsed JSON body (null when no body was sent). */
  readonly body: unknown;
  /** Origin for absolute pagination URLs, e.g. "http://127.0.0.1:12345". */
  readonly origin: string;
}

export interface RestResponse {
  readonly status: number;
  readonly headers?: Record<string, string>;
  /** JSON value, or null for an empty (204) body. */
  readonly body: unknown;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return { status, body, headers };
}

function notFound(message = 'Not Found'): RestResponse {
  return json(404, { message });
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repoNumericId(repo),
    name: repo.name,
    full_name: `${VIEWER.login}/${repo.name}`,
    owner: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    fork: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `https://github.example/${VIEWER.login}/${repo.name}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issueNumericId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: deterministicIso(issue.createdSeq),
    updated_at: deterministicIso(issue.updatedSeq),
    html_url: `https://github.example/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.pullHeadSha(repo, pull);
  const baseSha = store.pullBaseSha(repo, pull);
  return {
    id: pullNumericId(repo, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha },
    base: { ref: pull.baseRef, sha: baseSha },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: deterministicIso(pull.createdSeq),
    html_url: `https://github.example/${VIEWER.login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/pulls/${pull.number}`,
  };
}

function bodyObject(body: unknown, label: string): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RestError(400, `${label}: expected a JSON object body`);
  }
  return body as Record<string, unknown>;
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string') throw new RestError(400, `field ${field} must be a string`);
  return value;
}

/** Resolve /repos/{owner}/{name} to a repo, or null (unknown owner or unknown repo -> 404). */
function resolveRepo(store: Store, owner: string | undefined, name: string | undefined): Repo | null {
  if (owner !== VIEWER.login || name === undefined) return null;
  return store.getRepo(name) ?? null;
}

function isoFromEpoch(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function handleRest(store: Store, req: RestRequest): RestResponse {
  const [first, second, third] = req.segments;
  try {
    if (first !== 'api' || second !== 'v3') return notFound();
    const rest = req.segments.slice(2);
    if (rest.length === 0) {
      if (req.method !== 'GET') return notFound();
      return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    if (rest[0] === 'meta' && rest.length === 1) {
      if (req.method !== 'GET') return notFound();
      return json(200, { installed_version: '1.0.0' });
    }
    if (rest[0] === 'user' && rest.length === 1) {
      if (req.method !== 'GET') return notFound();
      return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    }
    if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
      if (req.method === 'POST') return createUserRepo(store, req);
      if (req.method === 'GET') return listUserRepos(store, req);
      return notFound();
    }
    if (rest[0] === 'repos' && rest.length >= 3) {
      return handleRepoRoute(store, req, rest.slice(1));
    }
    return notFound();
  } catch (error) {
    if (error instanceof RestError) return json(error.status, { message: error.message });
    throw error;
  }
}

function createUserRepo(store: Store, req: RestRequest): RestResponse {
  const body = bodyObject(req.body, 'POST /api/v3/user/repos');
  const name = bodyString(body, 'name');
  if (name === '' || name.length > 100 || /[\s/]/.test(name)) throw new RestError(422, 'invalid repository name');
  const isPrivate = body.private === undefined ? false : body.private === true;
  const description = typeof body.description === 'string' ? body.description : '';
  const repo = store.createRepo(name, isPrivate, description);
  if (repo === null) throw new RestError(422, `repository ${name} already exists`);
  return json(201, repoJson(repo));
}

function listUserRepos(store: Store, req: RestRequest): RestResponse {
  const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  const all = store.listRepos();
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const nextUrl = `${req.origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    headers.link = `<${nextUrl}>; rel="next"`;
  }
  return json(200, items.map(repoJson), headers);
}

function handleRepoRoute(store: Store, req: RestRequest, segments: string[]): RestResponse {
  // segments: [owner, name, ...tail]
  const repo = resolveRepo(store, segments[0], segments[1]);
  if (repo === null) return notFound();
  const tail = segments.slice(2);
  if (tail.length === 0) {
    if (req.method === 'GET') return json(200, repoJson(repo));
    if (req.method === 'PATCH') {
      const body = bodyObject(req.body, 'PATCH repo');
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return json(200, repoJson(repo));
    }
    if (req.method === 'DELETE') {
      store.deleteRepo(repo.name);
      return { status: 204, body: null };
    }
    return notFound();
  }
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
    if (req.method !== 'POST') return notFound();
    const body = bodyObject(req.body, 'POST /git/refs');
    const ref = bodyString(body, 'ref');
    const sha = bodyString(body, 'sha');
    if (!ref.startsWith('refs/')) throw new RestError(422, 'ref must start with refs/');
    if (repo.refs.has(ref)) throw new RestError(422, `ref ${ref} already exists`);
    const commit = store.peelToCommit(repo, sha);
    if (commit === null) throw new RestError(422, 'sha does not resolve to a commit');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha } });
  }
  if (tail[0] === 'branches' && tail.length === 1) {
    if (req.method !== 'GET') return notFound();
    return json(
      200,
      store.listBranches(repo).map((branch) => ({ name: branch.name, commit: { sha: branch.sha } })),
    );
  }
  if (tail[0] === 'commits' && tail.length === 1) {
    if (req.method !== 'GET') return notFound();
    const ref = req.query.get('sha') ?? repo.defaultBranch;
    const tip = store.resolveToCommit(repo, ref);
    if (tip === null) return notFound();
    const commits = store.listCommits(repo, tip).map(({ sha, commit }) => {
      const authorEpoch = parseEpoch(commit.author);
      return {
        sha,
        commit: {
          message: commit.message,
          author: { name: VIEWER.name, email: VIEWER.email, date: isoFromEpoch(authorEpoch) },
          committer: { name: VIEWER.name, email: VIEWER.email, date: isoFromEpoch(authorEpoch) },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return json(200, commits);
  }
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (req.method === 'GET') return getContents(store, repo, req, path);
    if (req.method === 'PUT') return putContents(store, repo, req, path);
    if (req.method === 'DELETE') return deleteContents(store, repo, req, path);
    return notFound();
  }
  if (tail[0] === 'labels') {
    if (tail.length === 1) {
      if (req.method === 'POST') return createLabel(store, repo, req);
      if (req.method === 'GET') return json(200, store.listLabels(repo).map(labelJson));
    }
    return notFound();
  }
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (req.method === 'POST') return createIssue(store, repo, req);
      if (req.method === 'GET') return listIssues(store, repo, req);
      return notFound();
    }
    const number = parseInt(tail[1] ?? '', 10);
    if (!Number.isSafeInteger(number) || number <= 0) return notFound();
    if (tail.length === 2) {
      if (req.method === 'GET') return getIssue(store, repo, number);
      if (req.method === 'PATCH') return patchIssue(store, repo, req, number);
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (req.method === 'POST') return createIssueComment(store, repo, req, number);
      if (req.method === 'GET') return listIssueComments(store, repo, number);
    }
    return notFound();
  }
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (req.method === 'POST') return createPull(store, repo, req);
      if (req.method === 'GET') return listPulls(store, repo, req);
      return notFound();
    }
    const number = parseInt(tail[1] ?? '', 10);
    if (!Number.isSafeInteger(number) || number <= 0) return notFound();
    if (tail.length === 2) {
      if (req.method === 'GET') return getPull(store, repo, number);
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (req.method === 'GET') return listPullFiles(store, repo, number);
      return notFound();
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (req.method === 'PUT') return mergePull(store, repo, req, number);
      return notFound();
    }
    return notFound();
  }
  return notFound();
}

/** The epoch seconds at the end of an "author Name <email> <epoch> +0000" line. */
function parseEpoch(line: string): number {
  const match = / (\d+) \+0000$/.exec(line);
  return match ? parseInt(match[1], 10) : 1735689600;
}

function getContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const ref = req.query.get('ref') ?? repo.defaultBranch;
  const found = store.contentAt(repo, ref, path);
  if (found === null) return notFound();
  if (found.kind === 'file') {
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: found.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: found.data.toString('base64'),
      sha: found.blobOid,
    });
  }
  return json(
    200,
    found.entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      sha: entry.oid,
    })),
  );
}

function putContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = bodyObject(req.body, 'PUT contents');
  const message = bodyString(body, 'message');
  const contentB64 = bodyString(body, 'content');
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const ref = branch ?? repo.defaultBranch;
  const existed = store.contentAt(repo, ref, path);
  const created = existed === null;
  const result = store.writeContent(repo, branch, path, content, message, sha);
  return json(created ? 201 : 200, {
    content: { name: path.split('/').pop() ?? path, path, sha: result.contentSha, size: content.length, encoding: 'base64' },
    commit: { sha: result.commitSha, message },
  });
}

function deleteContents(store: Store, repo: Repo, req: RestRequest, path: string): RestResponse {
  const body = req.body === null ? {} : bodyObject(req.body, 'DELETE contents');
  const message = typeof body.message === 'string' ? body.message : '';
  const branch = typeof body.branch === 'string' ? body.branch : undefined;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const result = store.deleteContent(repo, branch, path, message, sha);
  return json(200, { commit: { sha: result.commitSha, message } });
}

// -------------------------------------------------------------------------------------------
// labels, issues, pull requests (phase 2)
// -------------------------------------------------------------------------------------------

function pageParams(req: RestRequest): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, parseInt(req.query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, parseInt(req.query.get('page') ?? '1', 10) || 1);
  return { perPage, page };
}

function createLabel(_store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body, 'POST /labels');
  const name = bodyString(body, 'name');
  const color = typeof body.color === 'string' ? body.color : 'ededed';
  const label = _store.createLabel(repo, name, color);
  if (label === null) throw new RestError(422, `label ${name} already exists`);
  return json(201, labelJson(label));
}

function createIssue(_store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body, 'POST /issues');
  const title = bodyString(body, 'title');
  const issueBody = typeof body.body === 'string' ? body.body : '';
  const labels: string[] = [];
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels) || body.labels.some((label) => typeof label !== 'string')) {
      throw new RestError(400, 'field labels must be an array of strings');
    }
    labels.push(...(body.labels as string[]));
  }
  const issue = _store.createIssue(repo, title, issueBody, labels);
  return json(201, issueJson(repo, issue));
}

function listIssues(_store: Store, repo: Repo, req: RestRequest): RestResponse {
  const { perPage, page } = pageParams(req);
  const issues = _store.listIssues(repo, {
    state: req.query.get('state') ?? undefined,
    sort: req.query.get('sort') ?? undefined,
    direction: req.query.get('direction') ?? undefined,
    perPage,
    page,
  });
  return json(200, issues.map((issue) => issueJson(repo, issue)));
}

function getIssue(_store: Store, repo: Repo, number: number): RestResponse {
  const issue = _store.getIssue(repo, number);
  if (issue === undefined) return notFound();
  return json(200, issueJson(repo, issue));
}

function patchIssue(_store: Store, repo: Repo, req: RestRequest, number: number): RestResponse {
  const body = bodyObject(req.body, 'PATCH /issues/{n}');
  const patch: { state?: string; title?: string; body?: string } = {};
  if (body.state !== undefined) {
    if (typeof body.state !== 'string') throw new RestError(400, 'field state must be a string');
    patch.state = body.state;
  }
  if (body.title !== undefined) patch.title = bodyString(body, 'title');
  if (body.body !== undefined) patch.body = bodyString(body, 'body');
  const issue = _store.patchIssue(repo, number, patch);
  return json(200, issueJson(repo, issue));
}

function createIssueComment(_store: Store, repo: Repo, req: RestRequest, number: number): RestResponse {
  const body = bodyObject(req.body, 'POST /issues/{n}/comments');
  const commentBody = bodyString(body, 'body');
  const comment = _store.addIssueComment(repo, number, commentBody);
  return json(201, {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: deterministicIso(comment.createdSeq),
    html_url: `https://github.example/${VIEWER.login}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/comments/${comment.id}`,
  });
}

function listIssueComments(_store: Store, repo: Repo, number: number): RestResponse {
  const issue = _store.getIssue(repo, number);
  if (issue === undefined) return notFound();
  return json(
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
      created_at: deterministicIso(comment.createdSeq),
      html_url: `https://github.example/${VIEWER.login}/${repo.name}/issues/${number}#issuecomment-${comment.id}`,
      url: `/api/v3/repos/${VIEWER.login}/${repo.name}/issues/comments/${comment.id}`,
    })),
  );
}

function createPull(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const body = bodyObject(req.body, 'POST /pulls');
  const head = bodyString(body, 'head');
  const base = bodyString(body, 'base');
  const title = bodyString(body, 'title');
  const pullBody = typeof body.body === 'string' ? body.body : '';
  const pull = store.createPull(repo, head, base, title, pullBody);
  return json(201, pullJson(store, repo, pull));
}

function listPulls(store: Store, repo: Repo, req: RestRequest): RestResponse {
  const { perPage, page } = pageParams(req);
  const pulls = store.listPulls(repo, { state: req.query.get('state') ?? undefined, perPage, page });
  return json(200, pulls.map((pull) => pullJson(store, repo, pull)));
}

function getPull(store: Store, repo: Repo, number: number): RestResponse {
  const pull = store.getPull(repo, number);
  if (pull === undefined) return notFound();
  return json(200, pullJson(store, repo, pull));
}

function listPullFiles(store: Store, repo: Repo, number: number): RestResponse {
  const pull = store.getPull(repo, number);
  if (pull === undefined) return notFound();
  return json(200, store.pullFiles(repo, pull));
}

function mergePull(store: Store, repo: Repo, _req: RestRequest, number: number): RestResponse {
  const result = store.mergePull(repo, number);
  return json(200, { merged: true, sha: result.sha, message: result.message });
}
