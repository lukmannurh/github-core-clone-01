// In-memory forge state. One viewer only: the contest's scenario seed fixes the viewer login
// (adaiversen) and the shop token is opaque, so the server cannot derive a login from it — any
// owner other than the viewer is a 404, never a 403 (the checks require exactly that).
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  oidOf,
  parseCommit,
  parseTag,
  parseTree,
  type CommitView,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** Identity line used for commits the REST surface creates. */
export const IDENTITY = `${VIEWER.name} <${VIEWER.email}>`;

/** Base epoch for REST-created commits; each commit adds its sequence number, so two runs of the
 * same request history produce byte-identical state (no wall clock anywhere observable). */
const COMMIT_EPOCH_BASE = 1735689600;

export interface Label {
  readonly name: string;
  color: string;
}

export interface IssueComment {
  readonly id: number;
  body: string;
  readonly createdSeq: number;
}

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdSeq: number;
  updatedSeq: number;
  readonly comments: IssueComment[];
}

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** Branch names as submitted (head is the feature branch, base the target). */
  readonly headRef: string;
  readonly baseRef: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/..., refs/tags/...) -> commit/tag oid. */
  readonly refs: Map<string, string>;
  readonly createdSeq: number;
  /** Labels by name, created through POST /labels. */
  readonly labels: Map<string, Label>;
  /** Issues and pull requests share one per-repo number sequence, like GitHub. */
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  nextNumber: number;
  nextCommentId: number;
  /** Monotonic creation counter for ordering issues/pulls (never a clock). */
  seq: number;
}

/** ISO timestamp for an epoch-seconds value (never a wall clock). */
export function epochIso(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The GraphQL `databaseId` / REST numeric `id` of a repo: stable, positive, 1-based. */
export function repoNumericId(repo: Repo): number {
  return repo.createdSeq + 1;
}

/** A stable positive numeric id for an issue, derived from its repo and number. */
export function issueNumericId(repo: Repo, number: number): number {
  return repoNumericId(repo) * 10_000_000 + number;
}

/** A stable positive numeric id for a pull request (disjoint from issue ids). */
export function pullNumericId(repo: Repo, number: number): number {
  return repoNumericId(repo) * 10_000_000 + 5_000_000 + number;
}

/** Deterministic ISO timestamp for a sequence number (never a wall clock). */
export function deterministicIso(seq: number): string {
  return epochIso(COMMIT_EPOCH_BASE + seq);
}

export class RestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private commitSeq = 0;

  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    if (this.repos.has(name)) return null;
    const repo: Repo = {
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      createdSeq: this.repoSeq++,
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      seq: 0,
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Deterministic timestamp for the next REST-created commit. */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return COMMIT_EPOCH_BASE + this.commitSeq;
  }

  putObject(repo: Repo, type: GitObject['type'], data: Buffer): string {
    const { oid } = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  /** Resolve a branch name, full ref, or oid to a commit oid (tags peel to their commit). */
  resolveToCommit(repo: Repo, ref: string): string | null {
    let oid: string | undefined;
    if (isObjectId(ref)) oid = ref;
    else if (ref.startsWith('refs/')) oid = repo.refs.get(ref);
    else oid = repo.refs.get(`refs/heads/${ref}`);
    if (oid === undefined) return null;
    return this.peelToCommit(repo, oid);
  }

  /** Follow tag objects to their commit target (bounded). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All commits reachable from `tip` (newest first by traversal), following parents. */
  listCommits(repo: Repo, tip: string): Array<{ sha: string; commit: CommitView }> {
    const out: Array<{ sha: string; commit: CommitView }> = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, commit });
      for (const parent of commit.parents) stack.push(parent);
    }
    return out;
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // labels, issues, pull requests (phase 2)
  // -------------------------------------------------------------------------------------------

  /** Create a label; null when the name already exists (GitHub answers 422). */
  createLabel(repo: Repo, name: string, color: string): Label | null {
    if (repo.labels.has(name)) return null;
    const label: Label = { name, color };
    repo.labels.set(name, label);
    return label;
  }

  listLabels(repo: Repo): Label[] {
    return [...repo.labels.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  /** Create an issue; unknown label names are a 422 (also what protocol.error-message needs). */
  createIssue(repo: Repo, title: string, body: string, labels: readonly string[]): Issue {
    for (const name of labels) {
      if (!repo.labels.has(name)) throw new RestError(422, `label ${name} does not exist`);
    }
    repo.seq += 1;
    const issue: Issue = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdSeq: repo.seq,
      updatedSeq: repo.seq,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.get(number);
  }

  listIssues(
    repo: Repo,
    options: { state?: string; sort?: string; direction?: string; perPage?: number; page?: number } = {},
  ): Issue[] {
    const state = options.state ?? 'open';
    const direction = options.direction ?? 'desc';
    let all = [...repo.issues.values()];
    if (state !== 'all') all = all.filter((issue) => issue.state === state);
    all.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return all.slice((page - 1) * perPage, page * perPage);
  }

  /** Patch an issue's state/title/body; unknown number is a 404, bad state a 422. */
  patchIssue(repo: Repo, number: number, patch: { state?: string; title?: string; body?: string }): Issue {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new RestError(404, 'Not Found');
    if (patch.state !== undefined) {
      if (patch.state !== 'open' && patch.state !== 'closed') throw new RestError(422, `invalid issue state ${patch.state}`);
      issue.state = patch.state;
    }
    if (patch.title !== undefined) issue.title = patch.title;
    if (patch.body !== undefined) issue.body = patch.body;
    repo.seq += 1;
    issue.updatedSeq = repo.seq;
    return issue;
  }

  /** Add a comment to an issue; unknown issue is a 404. */
  addIssueComment(repo: Repo, number: number, body: string): IssueComment {
    const issue = repo.issues.get(number);
    if (issue === undefined) throw new RestError(404, 'Not Found');
    repo.seq += 1;
    const comment: IssueComment = { id: repo.nextCommentId++, body, createdSeq: repo.seq };
    issue.comments.push(comment);
    issue.updatedSeq = repo.seq;
    return comment;
  }

  /** Create a pull request; unknown head/base branches are a 422. */
  createPull(repo: Repo, head: string, base: string, title: string, body: string): PullRequest {
    if (head === base) throw new RestError(422, 'head and base must be different branches');
    if (!repo.refs.has(`refs/heads/${head}`)) throw new RestError(422, `head branch ${head} does not exist`);
    if (!repo.refs.has(`refs/heads/${base}`)) throw new RestError(422, `base branch ${base} does not exist`);
    repo.seq += 1;
    const pull: PullRequest = {
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      createdSeq: repo.seq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  getPull(repo: Repo, number: number): PullRequest | undefined {
    return repo.pulls.get(number);
  }

  listPulls(
    repo: Repo,
    options: { state?: string; perPage?: number; page?: number } = {},
  ): PullRequest[] {
    const state = options.state ?? 'open';
    let all = [...repo.pulls.values()];
    if (state !== 'all') all = all.filter((pull) => pull.state === state);
    all.sort((a, b) => b.createdSeq - a.createdSeq);
    const perPage = Math.max(1, Math.min(100, options.perPage ?? 30));
    const page = Math.max(1, options.page ?? 1);
    return all.slice((page - 1) * perPage, page * perPage);
  }

  /** Current tip of a pull request's head/base branch (live ref, like GitHub). */
  pullHeadSha(repo: Repo, pull: PullRequest): string | null {
    const tip = repo.refs.get(`refs/heads/${pull.headRef}`);
    if (tip === undefined) return null;
    return this.peelToCommit(repo, tip);
  }

  pullBaseSha(repo: Repo, pull: PullRequest): string | null {
    const tip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (tip === undefined) return null;
    return this.peelToCommit(repo, tip);
  }

  /**
   * The first path changed on both sides (head and base, to different blobs) since the merge
   * base, or null when the two sides do not conflict. Null also when either tip is missing
   * (there is nothing to compare yet) — callers treat that as "unknown", not "clean".
   */
  findMergeConflict(repo: Repo, pull: PullRequest): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const headCommit = this.peelToCommit(repo, headTip);
    const baseCommit = this.peelToCommit(repo, baseTip);
    if (headCommit === null || baseCommit === null) return null;
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseCommit)!.data).tree;
    const mergeBase = this.mergeBase(repo, headCommit, baseCommit);
    const mergeBaseTree = mergeBase === null ? null : parseCommit(repo.objects.get(mergeBase)!.data).tree;
    const headChanges = this.treeDiff(repo, mergeBaseTree, headTree);
    const baseChanges = this.treeDiff(repo, mergeBaseTree, baseTree);
    const baseByPath = new Map(baseChanges.map((change) => [change.path, change]));
    for (const change of headChanges) {
      const other = baseByPath.get(change.path);
      if (other !== undefined && other.newOid !== change.newOid) return change.path;
    }
    return null;
  }

  /** The GraphQL mergeable state of a pull request: MERGEABLE, CONFLICTING, or UNKNOWN. */
  pullMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    if (this.peelToCommit(repo, headTip) === null || this.peelToCommit(repo, baseTip) === null) return 'UNKNOWN';
    return this.findMergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /**
   * Squash-merge a pull request: one new commit on the base branch whose tree is the base tree
   * with the head's changes (relative to the merge base) applied. A path changed on both sides
   * to different blobs is a conflict (405). Returns the merge commit sha and message.
   */
  mergePull(repo: Repo, number: number): { sha: string; message: string } {
    const pull = repo.pulls.get(number);
    if (pull === undefined) throw new RestError(404, 'Not Found');
    if (pull.state !== 'open') throw new RestError(405, 'pull request is not open');
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) throw new RestError(422, 'head or base branch is gone');
    const headCommit = this.peelToCommit(repo, headTip);
    const baseCommit = this.peelToCommit(repo, baseTip);
    if (headCommit === null || baseCommit === null) throw new RestError(422, 'head or base does not resolve to a commit');
    const baseObject = repo.objects.get(baseCommit);
    const headObject = repo.objects.get(headCommit);
    if (baseObject === undefined || headObject === undefined) throw new RestError(422, 'head or base commit is missing');
    const baseTree = parseCommit(baseObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const conflict = this.findMergeConflict(repo, pull);
    if (conflict !== null) {
      throw new RestError(405, `merge conflict: ${conflict} changed on both sides`);
    }
    const mergeBase = this.mergeBase(repo, headCommit, baseCommit);
    const mergeBaseTree = mergeBase === null ? null : parseCommit(repo.objects.get(mergeBase)!.data).tree;
    const headChanges = this.treeDiff(repo, mergeBaseTree, headTree);
    const mergedFlat = this.flattenTree(repo, baseTree);
    for (const change of headChanges) {
      if (change.newOid === null) mergedFlat.delete(change.path);
      else mergedFlat.set(change.path, { mode: change.mode, oid: change.newOid });
    }
    const mergedTree = this.buildTreeFromFlat(repo, mergedFlat);
    const timestamp = this.nextCommitTimestamp();
    const message = `Merge pull request #${pull.number} from ${VIEWER.login}/${pull.headRef}`;
    const commitData = buildCommit({
      tree: mergedTree,
      parents: [baseCommit],
      author: IDENTITY,
      committer: IDENTITY,
      timestamp,
      message,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = epochIso(timestamp);
    pull.mergeCommitSha = mergeSha;
    return { sha: mergeSha, message };
  }

  /** Files a pull request changes, diffed merge-base -> head, with line counts. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const headCommit = this.peelToCommit(repo, headTip);
    const baseCommit = this.peelToCommit(repo, baseTip);
    if (headCommit === null || baseCommit === null) return [];
    const headTree = parseCommit(repo.objects.get(headCommit)!.data).tree;
    const mergeBase = this.mergeBase(repo, headCommit, baseCommit);
    const mergeBaseTree = mergeBase === null ? null : parseCommit(repo.objects.get(mergeBase)!.data).tree;
    const changes = this.treeDiff(repo, mergeBaseTree, headTree);
    const baseFlat = mergeBaseTree === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, mergeBaseTree);
    const headFlat = this.flattenTree(repo, headTree);
    return changes.map((change) => {
      const oldEntry = baseFlat.get(change.path);
      const newEntry = headFlat.get(change.path);
      const oldText = oldEntry === undefined ? '' : this.blobText(repo, oldEntry.oid);
      const newText = newEntry === undefined ? '' : this.blobText(repo, newEntry.oid);
      let status: string;
      let additions: number;
      let deletions: number;
      if (oldEntry === undefined) {
        status = 'added';
        additions = splitLines(newText).length;
        deletions = 0;
      } else if (newEntry === undefined) {
        status = 'removed';
        additions = 0;
        deletions = splitLines(oldText).length;
      } else {
        status = 'modified';
        const counted = countLineDiff(oldText, newText);
        additions = counted.additions;
        deletions = counted.deletions;
      }
      return { filename: change.path, status, additions, deletions, changes: additions + deletions };
    });
  }

  /** Blob bytes as UTF-8 text (empty when the object is missing or not a blob). */
  private blobText(repo: Repo, oid: string): string {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  /** A common ancestor of two commits (first shared commit walking from `b` newest-first). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsOfA = new Set<string>();
    const stack = [a];
    while (stack.length) {
      const current = stack.pop()!;
      if (ancestorsOfA.has(current)) continue;
      ancestorsOfA.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    for (const { sha } of this.listCommits(repo, b)) {
      if (ancestorsOfA.has(sha)) return sha;
    }
    return null;
  }

  /** Every file in a tree, path -> {mode, oid}, recursing into subdirectories. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /**
   * Path changes from `fromTree` to `toTree` (null tree = the empty tree). `newOid` null means
   * the path was deleted. Sorted by path for determinism.
   */
  treeDiff(
    repo: Repo,
    fromTree: string | null,
    toTree: string,
  ): Array<{ path: string; mode: string; newOid: string | null }> {
    const from = fromTree === null ? new Map<string, { mode: string; oid: string }>() : this.flattenTree(repo, fromTree);
    const to = this.flattenTree(repo, toTree);
    const out: Array<{ path: string; mode: string; newOid: string | null }> = [];
    for (const [path, entry] of to) {
      const old = from.get(path);
      if (old === undefined || old.oid !== entry.oid || old.mode !== entry.mode) {
        out.push({ path, mode: entry.mode, newOid: entry.oid });
      }
    }
    for (const path of from.keys()) {
      if (!to.has(path)) out.push({ path, mode: '100644', newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** Rebuild a root tree from a flat path map (bottom-up, directories from their children). */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
    interface DirNode {
      files: Array<{ mode: string; name: string; oid: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: [], dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/').filter((segment) => segment !== '');
      let node = root;
      for (const segment of segments.slice(0, -1)) {
        let child = node.dirs.get(segment);
        if (child === undefined) {
          child = { files: [], dirs: new Map() };
          node.dirs.set(segment, child);
        }
        node = child;
      }
      node.files.push({ mode: entry.mode, name: segments[segments.length - 1]!, oid: entry.oid });
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [...node.files];
      for (const [name, child] of node.dirs) {
        entries.push({ mode: '40000', name, oid: build(child) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  // -------------------------------------------------------------------------------------------
  // contents: read a file or directory at a ref; write/delete a file as a new commit
  // -------------------------------------------------------------------------------------------

  /** Resolve `path` inside the tree at `ref` (branch name, ref, or oid). */
  contentAt(
    repo: Repo,
    ref: string,
    path: string,
  ): { kind: 'file'; blobOid: string; data: Buffer } | { kind: 'dir'; entries: TreeEntry[] } | null {
    const tip = this.resolveToCommit(repo, ref);
    if (tip === null) return null;
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') return null;
    const rootTree = parseCommit(commitObject.data).tree;
    const segments = path.split('/').filter((segment) => segment !== '');
    let treeOid = rootTree;
    for (let index = 0; index < segments.length; index += 1) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return null;
      const entries = parseTree(treeObject.data);
      const entry = entries.find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') {
          const dirObject = repo.objects.get(entry.oid);
          if (dirObject === undefined || dirObject.type !== 'tree') return null;
          return { kind: 'dir', entries: parseTree(dirObject.data) };
        }
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined || blob.type !== 'blob') return null;
        return { kind: 'file', blobOid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    const rootObject = repo.objects.get(rootTree);
    if (rootObject === undefined || rootObject.type !== 'tree') return null;
    return { kind: 'dir', entries: parseTree(rootObject.data) };
  }

  /**
   * Write `content` at `path` on `branch` (default branch when omitted) as one commit.
   * `expectedSha` (when given) must be the current blob sha or the write is a 409.
   */
  writeContent(
    repo: Repo,
    branch: string | undefined,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commitSha: string; contentSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) throw new RestError(422, 'empty content path');
    let rootTree = '';
    const parents: string[] = [];
    if (tip !== undefined) {
      const commitObject = repo.objects.get(tip);
      if (commitObject === undefined || commitObject.type !== 'commit') throw new RestError(422, 'branch tip is not a commit');
      rootTree = parseCommit(commitObject.data).tree;
      parents.push(tip);
      const current = this.contentAt(repo, ref, path);
      if (current !== null && current.kind === 'file') {
        if (expectedSha === undefined) throw new RestError(422, 'sha is required to update a file');
        if (expectedSha.toLowerCase() !== current.blobOid.toLowerCase()) {
          throw new RestError(409, 'sha does not match the current blob');
        }
      } else if (current !== null && current.kind === 'dir') {
        throw new RestError(422, 'path is a directory');
      } else if (expectedSha !== undefined) {
        throw new RestError(409, 'sha does not match the current blob');
      }
    } else if (expectedSha !== undefined) {
      throw new RestError(409, 'sha does not match the current blob');
    }
    const blobOid = this.putObject(repo, 'blob', content);
    const newRoot = this.setPath(repo, rootTree === '' ? null : rootTree, segments, blobOid);
    const commitData = buildCommit({
      tree: newRoot,
      parents,
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextCommitTimestamp(),
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha: blobOid };
  }

  /** Delete the file at `path` on `branch` as one commit. */
  deleteContent(
    repo: Repo,
    branch: string | undefined,
    path: string,
    message: string,
    expectedSha?: string,
  ): { commitSha: string } {
    const branchName = branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branchName}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined) throw new RestError(404, 'Not Found');
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) throw new RestError(422, 'empty content path');
    const current = this.contentAt(repo, ref, path);
    if (current === null || current.kind !== 'file') throw new RestError(404, 'Not Found');
    if (expectedSha !== undefined && expectedSha.toLowerCase() !== current.blobOid.toLowerCase()) {
      throw new RestError(409, 'sha does not match the current blob');
    }
    const commitObject = repo.objects.get(tip);
    if (commitObject === undefined || commitObject.type !== 'commit') throw new RestError(422, 'branch tip is not a commit');
    const rootTree = parseCommit(commitObject.data).tree;
    const newRoot = this.deletePath(repo, rootTree, segments);
    const commitData = buildCommit({
      tree: newRoot,
      parents: [tip],
      author: IDENTITY,
      committer: IDENTITY,
      timestamp: this.nextCommitTimestamp(),
      message,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha };
  }

  /** Return the root tree oid after setting `segments` to `blobOid` (creating dirs as needed). */
  private setPath(repo: Repo, treeOid: string | null, segments: readonly string[], blobOid: string): string {
    if (segments.length === 1) {
      const entries: TreeEntry[] = [];
      if (treeOid !== null) {
        const treeObject = repo.objects.get(treeOid);
        if (treeObject !== undefined && treeObject.type === 'tree') {
          for (const entry of parseTree(treeObject.data)) {
            if (entry.name !== segments[0]) entries.push(entry);
          }
        }
      }
      entries.push({ mode: '100644', name: segments[0], oid: blobOid });
      return this.putObject(repo, 'tree', buildTree(entries));
    }
    const entries: TreeEntry[] = [];
    let childOid: string | null = null;
    if (treeOid !== null) {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject !== undefined && treeObject.type === 'tree') {
        for (const entry of parseTree(treeObject.data)) {
          if (entry.name === segments[0] && entry.mode === '40000') childOid = entry.oid;
          else if (entry.name !== segments[0]) entries.push(entry);
        }
      }
    }
    const newChild = this.setPath(repo, childOid, segments.slice(1), blobOid);
    entries.push({ mode: '40000', name: segments[0], oid: newChild });
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  /** Return the root tree oid after removing `segments` (pruning dirs left empty). */
  private deletePath(repo: Repo, treeOid: string, segments: readonly string[]): string {
    const treeObject = repo.objects.get(treeOid);
    if (treeObject === undefined || treeObject.type !== 'tree') throw new RestError(404, 'Not Found');
    const entries: TreeEntry[] = [];
    for (const entry of parseTree(treeObject.data)) {
      if (entry.name !== segments[0]) {
        entries.push(entry);
        continue;
      }
      if (segments.length === 1) continue; // drop the entry
      if (entry.mode !== '40000') throw new RestError(404, 'Not Found');
      const newChild = this.deletePath(repo, entry.oid, segments.slice(1));
      const childObject = repo.objects.get(newChild);
      const childEntries = childObject !== undefined && childObject.type === 'tree' ? parseTree(childObject.data) : [];
      if (childEntries.length > 0) entries.push({ mode: '40000', name: entry.name, oid: newChild });
      // An emptied directory is pruned, like git.
    }
    return this.putObject(repo, 'tree', buildTree(entries));
  }

  // -------------------------------------------------------------------------------------------
  // graph traversal for fetch/clone: which objects to send, and which are already held
  // -------------------------------------------------------------------------------------------

  /**
   * Commits reachable from `tips` (tag tips peel to their commit), with BFS distance from the
   * nearest tip. `depth` limits the distance included (undefined = whole history). Descent stops
   * past commits in `stopAt` (they are included, their parents are not).
   */
  collectCommits(
    repo: Repo,
    tips: Iterable<string>,
    options: { depth?: number; stopAt?: ReadonlySet<string> } = {},
  ): Map<string, number> {
    const distance = new Map<string, number>();
    const queue: string[] = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(repo, tip);
      if (commit === null) continue;
      if (!distance.has(commit)) {
        distance.set(commit, 0);
        queue.push(commit);
      }
    }
    while (queue.length) {
      const oid = queue.shift()!;
      const dist = distance.get(oid)!;
      if (options.stopAt?.has(oid)) continue;
      if (options.depth !== undefined && dist >= options.depth - 1) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!distance.has(parent)) {
          distance.set(parent, dist + 1);
          queue.push(parent);
        }
      }
    }
    return distance;
  }

  /**
   * Every object in the closure of a set of commits: the commits themselves plus their trees and
   * blobs, recursively. Parent commits are NOT followed: the caller decides which commits belong
   * (collectCommits applies the depth limit and the shallow-boundary truncation), so this stays
   * exact for shallow and incremental fetches.
   */
  reachableObjects(repo: Repo, commits: Iterable<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack: string[] = [];
    for (const oid of commits) stack.push(oid);
    while (stack.length) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      out.set(oid, object);
      if (object.type === 'commit') {
        stack.push(parseCommit(object.data).tree);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return out;
  }

  /**
   * Objects the client already holds: reachable from `haves`, with descent truncated at the
   * shallow boundaries (a boundary commit is held, its parents are not — the client never got them).
   */
  heldObjects(repo: Repo, haves: Iterable<string>, shallow: Iterable<string>): Map<string, GitObject> {
    const stopAt = new Set<string>(shallow);
    const commits = this.collectCommits(repo, haves, { stopAt });
    return this.reachableObjects(repo, commits.keys());
  }

  /** Is `ancestor` an ancestor of (or equal to) `oid`? Tags peel to commits first. */
  isAncestor(repo: Repo, ancestor: string, oid: string): boolean {
    const ancCommit = this.peelToCommit(repo, ancestor);
    const tipCommit = this.peelToCommit(repo, oid);
    if (ancCommit === null || tipCommit === null) return false;
    if (ancCommit === tipCommit) return true;
    const seen = new Set<string>();
    const stack = [tipCommit];
    while (stack.length) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancCommit) return true;
        stack.push(parent);
      }
    }
    return false;
  }
}

/** The oid of an empty tree (git's well-known constant). */
export function emptyTreeOid(store: Store, repo: Repo): string {
  return store.putObject(repo, 'tree', buildTree([]));
}

/** Split text into lines; a trailing newline does not make an empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts between two texts (LCS over lines; bounded inputs only). */
export function countLineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldLines.length + newLines.length > 4000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  // Two-row LCS: additions = new lines not in the LCS, deletions = old lines not in it.
  let prev = new Array<number>(newLines.length + 1).fill(0);
  let curr = new Array<number>(newLines.length + 1).fill(0);
  for (let i = 1; i <= oldLines.length; i += 1) {
    for (let j = 1; j <= newLines.length; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
    curr.fill(0);
  }
  const lcs = prev[newLines.length];
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

export { ZERO_OID };
