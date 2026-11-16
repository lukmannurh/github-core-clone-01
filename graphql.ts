// GraphQL surface (phase 3): a small, dependency-free executor for the subset the conformance
// suite uses — queries, mutations, variables, aliases, inline fragments, __type introspection,
// batched operation arrays. It is deliberately not a full GraphQL implementation: unknown fields
// are errors (the suite checks that), unknown repos are null (never an error), and every id is
// derived deterministically from repo name + number so replays stay byte-identical.

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

/* ------------------------------------------------------------------ types */

type GqlValue = null | boolean | number | string | GqlValue[] | { [key: string]: GqlValue };

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: GqlValue };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  arguments: ArgumentNode[];
  selections: SelectionNode[] | null;
}

interface InlineFragmentNode {
  kind: 'inline';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | InlineFragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

/** The runtime objects a field can return; __typename drives fragment matching. */
type RuntimeObject =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'User'; login: string }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __typename: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[] }
  | { __typename: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: '__Type'; name: string }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string }
  | { __typename: 'CreateIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CloseIssuePayload'; repo: Repo; issue: Issue }
  | { __typename: 'CreatePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __typename: 'MergePullRequestPayload'; repo: Repo; pull: PullRequest }
  | { __typename: 'AddCommentPayload'; repo: Repo; comment: { id: number; body: string }; issueNumber: number }
  | { __typename: 'IssueCommentEdge'; repo: Repo; comment: { id: number; body: string }; issueNumber: number }
  | { __typename: 'IssueComment'; repo: Repo; comment: { id: number; body: string }; issueNumber: number };

/** The fields each type exposes (used for validation + __type introspection). */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  PullRequestConnection: ['nodes'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  Ref: ['name'],
  __Type: ['name', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  Node: ['id'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'];

/* ------------------------------------------------------- global ids + cursors */

/** Opaque Relay-style global ids: base64 of "tag:payload", never a bare database id. */
function encodeGlobalId(tag: string, payload: string): string {
  return Buffer.from(`${tag}:${payload}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { tag: string; payload: string } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const idx = decoded.indexOf(':');
  if (idx <= 0) return null;
  return { tag: decoded.slice(0, idx), payload: decoded.slice(idx + 1) };
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('R', `${VIEWER.login}:${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('I', `${VIEWER.login}:${repo.name}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return encodeGlobalId('PR', `${VIEWER.login}:${repo.name}:${pull.number}`);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGlobalId('C', `${VIEWER.login}:${repo.name}:${issueNumber}:${commentId}`);
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): number | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^cursor:(\d+)$/.exec(decoded);
  return match === null ? null : Number(match[1]);
}

/* ------------------------------------------------------------------ tokenizer */

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string };

class GqlError extends Error {}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let raw = '"';
      while (j < source.length) {
        const c = source[j];
        raw += c;
        if (c === '\\') {
          j += 1;
          if (j < source.length) raw += source[j];
        } else if (c === '"') {
          break;
        }
        j += 1;
      }
      if (j >= source.length) throw new GqlError('unterminated string in GraphQL document');
      let value: string;
      try {
        value = JSON.parse(raw) as string;
      } catch {
        throw new GqlError('invalid string literal in GraphQL document');
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new GqlError(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

/* ------------------------------------------------------------------ parser */

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlError('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new GqlError(`expected "${value}" in GraphQL document, got ${token.value}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new GqlError(`expected a name in GraphQL document, got ${token.value}`);
    if (value !== undefined && token.value !== value) {
      throw new GqlError(`expected "${value}" in GraphQL document, got ${token.value}`);
    }
    return token.value;
  }

  /** Skip a balanced parenthesised group (variable definitions: names and types only). */
  private skipParens(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    const token = this.peek();
    if (token === undefined) throw new GqlError('unexpected end of GraphQL document');
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'query', name: null, selections: this.parseSelectionSet() };
    }
    const keyword = this.expectName();
    if (keyword !== 'query' && keyword !== 'mutation') {
      throw new GqlError(`unsupported operation "${keyword}" in GraphQL document`);
    }
    let name: string | null = null;
    const next = this.peek();
    if (next !== undefined && next.kind === 'name') name = this.expectName();
    const afterName = this.peek();
    if (afterName !== undefined && afterName.kind === 'punct' && afterName.value === '(') this.skipParens();
    return { kind: keyword, name, selections: this.parseSelectionSet() };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new GqlError('unexpected end of GraphQL document');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === '...') {
      this.next();
      const after = this.peek();
      if (after !== undefined && after.kind === 'name' && after.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (after !== undefined && after.kind === 'name') {
        throw new GqlError('named fragments are not supported');
      }
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const name = this.expectName();
    let alias: string | null = null;
    let fieldName = name;
    const colon = this.peek();
    if (colon !== undefined && colon.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = name;
      fieldName = this.expectName();
    }
    const args: ArgumentNode[] = [];
    const paren = this.peek();
    if (paren !== undefined && paren.kind === 'punct' && paren.value === '(') {
      this.next();
      for (;;) {
        const next = this.peek();
        if (next === undefined) throw new GqlError('unexpected end of GraphQL document');
        if (next.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selections: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', name: fieldName, alias, arguments: args, selections };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      for (;;) {
        const next = this.peek();
        if (next === undefined) throw new GqlError('unexpected end of GraphQL document');
        if (next.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'literal', value: items };
        }
        items.push(this.resolveLiteral(this.parseValue()));
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: GqlValue } = {};
      for (;;) {
        const next = this.peek();
        if (next === undefined) throw new GqlError('unexpected end of GraphQL document');
        if (next.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'literal', value: object };
        }
        const fieldName = this.expectName();
        this.expectPunct(':');
        object[fieldName] = this.resolveLiteral(this.parseValue());
      }
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int') return { kind: 'literal', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'literal', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new GqlError(`unexpected token ${token.value} in GraphQL document`);
  }

  /** Resolve a value node whose variables are already bound (used inside literals). */
  private resolveLiteral(node: ValueNode): GqlValue {
    if (node.kind === 'literal') return node.value;
    throw new GqlError('variables are not allowed inside list/object literals');
  }
}

/* ------------------------------------------------------------------ executor */

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.kind === 'variable') return variables[node.name] ?? null;
  return node.value;
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.arguments) args[arg.name] = resolveValue(arg.value, variables);
  return args;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Look a repo up by owner + name; null when the owner is not the viewer or the repo is missing. */
function findRepo(store: Store, owner: string | null, name: string | null): Repo | null {
  if (owner === null || name === null || owner !== VIEWER.login) return null;
  return store.getRepo(name) ?? null;
}

/** Decode a global id of the expected tag into its repo (+ optional number). */
function decodeRef(store: Store, id: unknown, tag: string): { repo: Repo; number: number | null } {
  const raw = asString(id);
  if (raw === null) throw new GqlError(`expected a global id for ${tag}`);
  const decoded = decodeGlobalId(raw);
  if (decoded === null || decoded.tag !== tag) throw new GqlError(`unknown ${tag} id`);
  const parts = decoded.payload.split(':');
  const owner = parts[0] ?? '';
  const repoName = parts[1] ?? '';
  const repo = findRepo(store, owner, repoName);
  if (repo === null) throw new GqlError(`unknown ${tag} id`);
  const number = parts.length > 2 ? Number(parts[2]) : null;
  return { repo, number: number !== null && Number.isFinite(number) ? number : null };
}

/** The issues connection for a repo: states filter, CREATED_AT ordering, cursor paging. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): RuntimeObject {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = asRecord(args.orderBy);
  const desc = orderBy !== null && orderBy.direction === 'DESC';
  list.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
  const after = asString(args.after);
  if (after !== null) {
    const cursorNumber = decodeCursor(after);
    if (cursorNumber !== null) {
      list = desc ? list.filter((issue) => issue.number < cursorNumber) : list.filter((issue) => issue.number > cursorNumber);
    }
  }
  const first = asNumber(args.first);
  const page = first === null ? list : list.slice(0, first);
  const hasNextPage = first !== null && list.length > first;
  const endCursor = page.length > 0 ? encodeCursor(page[page.length - 1].number) : null;
  return { __typename: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
}

/** Resolve one field on one runtime object (null when the field is legitimately absent). */
function resolveField(ctx: Ctx, typeName: string, obj: RuntimeObject, field: FieldNode): unknown {
  const args = argsOf(field, ctx.variables);
  const store = ctx.store;

  if (typeName === 'Query') {
    if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login } satisfies RuntimeObject;
    if (field.name === 'repository') {
      const repo = findRepo(store, asString(args.owner), asString(args.name));
      return repo === null ? null : ({ __typename: 'Repository', repo } satisfies RuntimeObject);
    }
    if (field.name === 'node') {
      const raw = asString(args.id);
      if (raw === null) return null;
      const decoded = decodeGlobalId(raw);
      if (decoded === null) return null;
      const parts = decoded.payload.split(':');
      const repo = findRepo(store, parts[0] ?? '', parts[1] ?? '');
      if (repo === null) return null;
      if (decoded.tag === 'R') return { __typename: 'Repository', repo } satisfies RuntimeObject;
      if (decoded.tag === 'I') {
        const issue = repo.issues.get(Number(parts[2]));
        return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } satisfies RuntimeObject);
      }
      if (decoded.tag === 'PR') {
        const pull = repo.pulls.get(Number(parts[2]));
        return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } satisfies RuntimeObject);
      }
      if (decoded.tag === 'C') {
        const issueNumber = Number(parts[2]);
        const commentId = Number(parts[3]);
        const issue = repo.issues.get(issueNumber);
        const comment = issue?.comments.find((candidate) => candidate.id === commentId);
        return comment === undefined
          ? null
          : ({ __typename: 'IssueComment', repo, comment, issueNumber } satisfies RuntimeObject);
      }
      if (decoded.tag === 'U' && decoded.payload === VIEWER.login) {
        return { __typename: 'User', login: VIEWER.login } satisfies RuntimeObject;
      }
      return null;
    }
    if (field.name === '__type') {
      const name = asString(args.name);
      if (name === null || !(name in TYPE_FIELDS) && name !== 'SearchType') return null;
      return { __typename: '__Type', name } satisfies RuntimeObject;
    }
  }

  if (typeName === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = asRecord(args.input) ?? {};
      const { repo } = decodeRef(store, input.repositoryId, 'R');
      const title = asString(input.title);
      if (title === null) throw new GqlError('createIssue requires a title');
      const issue = store.createIssue(repo, title, asString(input.body) ?? '', []);
      return { __typename: 'CreateIssuePayload', repo, issue } satisfies RuntimeObject;
    }
    if (field.name === 'closeIssue') {
      const input = asRecord(args.input) ?? {};
      const { repo, number } = decodeRef(store, input.issueId, 'I');
      if (number === null) throw new GqlError('closeIssue requires an issue id');
      const issue = store.patchIssue(repo, number, { state: 'closed' });
      return { __typename: 'CloseIssuePayload', repo, issue } satisfies RuntimeObject;
    }
    if (field.name === 'createPullRequest') {
      const input = asRecord(args.input) ?? {};
      const { repo } = decodeRef(store, input.repositoryId, 'R');
      const title = asString(input.title);
      const head = asString(input.headRefName);
      const base = asString(input.baseRefName);
      if (title === null || head === null || base === null) {
        throw new GqlError('createPullRequest requires title, headRefName and baseRefName');
      }
      const pull = store.createPull(repo, head, base, title, asString(input.body) ?? '');
      return { __typename: 'CreatePullRequestPayload', repo, pull } satisfies RuntimeObject;
    }
    if (field.name === 'mergePullRequest') {
      const input = asRecord(args.input) ?? {};
      const { repo, number } = decodeRef(store, input.pullRequestId, 'PR');
      if (number === null) throw new GqlError('mergePullRequest requires a pull request id');
      try {
        store.mergePull(repo, number);
      } catch (err) {
        if (err instanceof RestError) throw new GqlError(err.message);
        throw err;
      }
      const pull = store.getPull(repo, number);
      if (pull === undefined) throw new GqlError('pull request is gone');
      return { __typename: 'MergePullRequestPayload', repo, pull } satisfies RuntimeObject;
    }
    if (field.name === 'addComment') {
      const input = asRecord(args.input) ?? {};
      const { repo, number } = decodeRef(store, input.subjectId, 'I');
      if (number === null) throw new GqlError('addComment requires an issue id');
      const body = asString(input.body);
      if (body === null) throw new GqlError('addComment requires a body');
      const comment = store.addIssueComment(repo, number, body);
      return { __typename: 'AddCommentPayload', repo, comment, issueNumber: number } satisfies RuntimeObject;
    }
  }

  if (typeName === 'User') {
    if (field.name === 'login') return (obj as { login: string }).login;
  }

  if (typeName === 'Repository') {
    const { repo } = obj as { repo: Repo };
    if (field.name === 'id') return repoGlobalId(repo);
    if (field.name === 'databaseId') return repoNumericId(repo);
    if (field.name === 'name') return repo.name;
    if (field.name === 'nameWithOwner') return `${VIEWER.login}/${repo.name}`;
    if (field.name === 'owner') return { __typename: 'User', login: VIEWER.login } satisfies RuntimeObject;
    if (field.name === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch } satisfies RuntimeObject;
    if (field.name === 'viewerPermission') return 'ADMIN';
    if (field.name === 'hasIssuesEnabled') return true;
    if (field.name === 'issue') {
      const number = asNumber(args.number);
      if (number === null) return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : ({ __typename: 'Issue', repo, issue } satisfies RuntimeObject);
    }
    if (field.name === 'issues') return issuesConnection(repo, args);
    if (field.name === 'pullRequests') {
      const list = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const first = asNumber(args.first);
      const page = first === null ? list : list.slice(0, first);
      return { __typename: 'PullRequestConnection', repo, pulls: page } satisfies RuntimeObject;
    }
    if (field.name === 'pullRequest') {
      const number = asNumber(args.number);
      if (number === null) return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : ({ __typename: 'PullRequest', repo, pull } satisfies RuntimeObject);
    }
  }

  if (typeName === 'Issue') {
    const { repo, issue } = obj as { repo: Repo; issue: Issue };
    if (field.name === 'id') return issueGlobalId(repo, issue);
    if (field.name === 'number') return issue.number;
    if (field.name === 'title') return issue.title;
    if (field.name === 'state') return issue.state.toUpperCase();
    if (field.name === 'body') return issue.body;
  }

  if (typeName === 'IssueConnection') {
    const conn = obj as { repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'nodes') {
      return conn.issues.map((issue) => ({ __typename: 'Issue', repo: conn.repo, issue }) satisfies RuntimeObject);
    }
    if (field.name === 'pageInfo') {
      return { __typename: 'PageInfo', hasNextPage: conn.hasNextPage, endCursor: conn.endCursor } satisfies RuntimeObject;
    }
  }

  if (typeName === 'PageInfo') {
    const page = obj as { hasNextPage: boolean; endCursor: string | null };
    if (field.name === 'hasNextPage') return page.hasNextPage;
    if (field.name === 'endCursor') return page.endCursor;
  }

  if (typeName === 'PullRequest') {
    const { repo, pull } = obj as { repo: Repo; pull: PullRequest };
    if (field.name === 'id') return pullGlobalId(repo, pull);
    if (field.name === 'number') return pull.number;
    if (field.name === 'title') return pull.title;
    if (field.name === 'body') return pull.body;
    if (field.name === 'state') return pull.state.toUpperCase();
    if (field.name === 'merged') return pull.merged;
    if (field.name === 'headRefName') return pull.headRef;
    if (field.name === 'baseRefName') return pull.baseRef;
    if (field.name === 'mergeable') return store.pullMergeable(repo, pull);
    if (field.name === 'files') {
      const files = store.pullFiles(repo, pull).map((file) => ({ path: file.filename }));
      const first = asNumber(args.first);
      const page = first === null ? files : files.slice(0, first);
      return { __typename: 'PullRequestChangedFileConnection', files: page } satisfies RuntimeObject;
    }
  }

  if (typeName === 'PullRequestConnection') {
    const conn = obj as { repo: Repo; pulls: PullRequest[] };
    if (field.name === 'nodes') {
      return conn.pulls.map((pull) => ({ __typename: 'PullRequest', repo: conn.repo, pull }) satisfies RuntimeObject);
    }
  }

  if (typeName === 'PullRequestChangedFileConnection') {
    const conn = obj as { files: Array<{ path: string }> };
    if (field.name === 'nodes') {
      return conn.files.map((file) => ({ __typename: 'PullRequestChangedFile', path: file.path }) satisfies RuntimeObject);
    }
  }

  if (typeName === 'PullRequestChangedFile') {
    if (field.name === 'path') return (obj as { path: string }).path;
  }

  if (typeName === 'Ref') {
    if (field.name === 'name') return (obj as { name: string }).name;
  }

  if (typeName === '__Type') {
    const typeObj = obj as { name: string };
    if (field.name === 'name') return typeObj.name;
    if (field.name === 'fields') {
      return (TYPE_FIELDS[typeObj.name] ?? []).map((name) => ({ __typename: '__Field', name }) satisfies RuntimeObject);
    }
    if (field.name === 'enumValues') {
      return typeObj.name === 'SearchType'
        ? SEARCH_TYPE_VALUES.map((name) => ({ __typename: '__EnumValue', name }) satisfies RuntimeObject)
        : [];
    }
  }

  if (typeName === '__Field' || typeName === '__EnumValue') {
    if (field.name === 'name') return (obj as { name: string }).name;
  }

  if (typeName === 'CreateIssuePayload' || typeName === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const payload = obj as { repo: Repo; issue: Issue };
      return { __typename: 'Issue', repo: payload.repo, issue: payload.issue } satisfies RuntimeObject;
    }
  }

  if (typeName === 'CreatePullRequestPayload' || typeName === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const payload = obj as { repo: Repo; pull: PullRequest };
      return { __typename: 'PullRequest', repo: payload.repo, pull: payload.pull } satisfies RuntimeObject;
    }
  }

  if (typeName === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const payload = obj as { repo: Repo; comment: { id: number; body: string }; issueNumber: number };
      return { __typename: 'IssueCommentEdge', repo: payload.repo, comment: payload.comment, issueNumber: payload.issueNumber } satisfies RuntimeObject;
    }
  }

  if (typeName === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const edge = obj as { repo: Repo; comment: { id: number; body: string }; issueNumber: number };
      return { __typename: 'IssueComment', repo: edge.repo, comment: edge.comment, issueNumber: edge.issueNumber } satisfies RuntimeObject;
    }
  }

  if (typeName === 'IssueComment') {
    const commentObj = obj as { repo: Repo; comment: { id: number; body: string }; issueNumber: number };
    if (field.name === 'id') return commentGlobalId(commentObj.repo, commentObj.issueNumber, commentObj.comment.id);
    if (field.name === 'body') return commentObj.comment.body;
  }

  throw new GqlError(`Cannot query field "${field.name}" on type "${typeName}".`);
}

/** Execute a selection set against a runtime object, collecting validation errors. */
function executeSelectionSet(
  typeName: string,
  obj: RuntimeObject,
  selections: SelectionNode[],
  ctx: Ctx,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelectionSet(typeName, obj, selection.selections, ctx, errors));
      continue;
    }
    const field = selection;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    if (fields === undefined || !fields.includes(field.name)) {
      errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[responseKey] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, obj, field);
    } catch (err) {
      throw err;
    }
    out[responseKey] = completeValue(value, field.selections, ctx, errors);
  }
  return out;
}

/** Apply a nested selection set to a resolved value (object, list, or scalar). */
function completeValue(
  value: unknown,
  selections: SelectionNode[] | null,
  ctx: Ctx,
  errors: Array<{ message: string }>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, selections, ctx, errors));
  }
  if (typeof value === 'object') {
    const obj = value as RuntimeObject;
    if (selections === null) return obj;
    if (typeof obj.__typename !== 'string') return obj;
    return executeSelectionSet(obj.__typename, obj, selections, ctx, errors);
  }
  return value;
}

/* ------------------------------------------------------------------ handler */

/** Execute one operation document ({query, variables}) into a GraphQL response. */
function executeDocument(store: Store, doc: unknown): Record<string, unknown> {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { errors: [{ message: 'expected a GraphQL operation document' }] };
  }
  const record = doc as Record<string, unknown>;
  if (typeof record.query !== 'string') {
    return { errors: [{ message: 'expected a GraphQL operation document' }] };
  }
  const variables = asRecord(record.variables) ?? {};
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(record.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (operations.length === 0) return { errors: [{ message: 'no operation in document' }] };
  const op = operations[0];
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const root: RuntimeObject = op.kind === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  const ctx: Ctx = { store, variables };
  const errors: Array<{ message: string }> = [];
  let data: Record<string, unknown> | null = null;
  try {
    data = executeSelectionSet(rootType, root, op.selections, ctx, errors);
  } catch (err) {
    errors.push({ message: err instanceof Error ? err.message : String(err) });
  }
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

/**
 * Handle POST /api/graphql. The body is one operation document or an array of them (batched
 * operations answer an array of results, in order). Callers must already have authenticated.
 */
export function handleGraphQL(store: Store, rawBody: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { errors: [{ message: 'malformed JSON body' }] } };
  }
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map((doc) => executeDocument(store, doc)) };
  }
  return { status: 200, body: executeDocument(store, parsed) };
}
