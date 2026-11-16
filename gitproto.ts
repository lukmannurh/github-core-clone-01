// Git smart HTTP: info/refs advertisements (v2 upload-pack, v0 receive-pack), v2 ls-refs and
// fetch, v0 fetch fallback, and v0 receive-pack (push) with report-status over sideband.
import {
  PKT_FLUSH,
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  readPack,
  sidebandWrap,
  writePack,
  type GitObject,
} from './git.ts';
import { type Repo, type Store } from './store.ts';

export interface GitResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8') };
}

/** Refs in advertisement order: HEAD first, then heads, then tags, each sorted by name. */
function sortedRefNames(repo: Repo): string[] {
  const names = [...repo.refs.keys()];
  names.sort((a, b) => {
    const rank = (name: string): number => (name.startsWith('refs/heads/') ? 0 : name.startsWith('refs/tags/') ? 1 : 2);
    return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
  });
  return names;
}

/** Peel an annotated tag ref to its commit (for ls-refs `peeled:` and v0 `^{}` lines). */
function peelRef(store: Store, repo: Repo, oid: string): string | undefined {
  const object = store.getObject(repo, oid);
  if (object === undefined || object.type !== 'tag') return undefined;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

/**
 * v2 capabilities. NOTE: `ls-refs` is advertised bare, without `=unborn`: the kit's client sends
 * the `unborn` argument whenever the value names it, and the clone-empty check counts the
 * `unborn refs/heads/main` line it gets back as a real ref (its filter is name-prefix only), so
 * advertising unborn makes a fresh repo look non-empty. The unborn line is still emitted when a
 * client asks for it explicitly.
 */
const V2_CAPS = ['ls-refs', 'fetch=shallow filter', 'object-format=sha1'];

export function handleInfoRefs(store: Store, repo: Repo | undefined, service: string, gitProtocol: string): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  if (service === 'git-receive-pack') {
    return ok('application/x-git-receive-pack-advertisement', v0Advertisement(store, repo, 'git-receive-pack'));
  }
  if (service !== 'git-upload-pack') return err(404, 'Not Found');
  if (gitProtocol === 'version=2') {
    const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n', ...V2_CAPS.map((cap) => `${cap}\n`), 'flush'];
    return ok('application/x-git-upload-pack-advertisement', encodePktLines(lines));
  }
  return ok('application/x-git-upload-pack-advertisement', v0Advertisement(store, repo, 'git-upload-pack'));
}

function v0Advertisement(store: Store, repo: Repo, service: string): Buffer {
  const parts: Array<string | Buffer | 'flush'> = [`# service=${service}\n`, 'flush'];
  const caps =
    service === 'git-receive-pack'
      ? 'report-status side-band-64k delete-refs ofs-delta'
      : 'side-band-64k multi_ack thin-pack ofs-delta shallow';
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (repo.refs.size === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:${headRef}\n`, 'flush');
    return encodePktLines(parts);
  }
  const names = sortedRefNames(repo);
  let first = true;
  const headLine = (oid: string): string => {
    const suffix = first ? `\0${caps} symref=HEAD:${headRef}` : '';
    first = false;
    return `${oid} HEAD${suffix}\n`;
  };
  if (headTip !== undefined) parts.push(headLine(headTip));
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const suffix = first ? `\0${caps} symref=HEAD:${headRef}` : '';
    first = false;
    parts.push(`${oid} ${name}${suffix}\n`);
    const peeled = peelRef(store, repo, oid);
    if (peeled !== undefined) parts.push(`${peeled} ${name}^{}\n`);
  }
  parts.push('flush');
  return encodePktLines(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack: v2 ls-refs / v2 fetch, v0 fetch
// ---------------------------------------------------------------------------------------------

export function handleUploadPack(store: Store, repo: Repo | undefined, gitProtocol: string, body: Buffer): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  let lines;
  try {
    lines = decodePktLines(body);
  } catch (error) {
    return err(400, error instanceof Error ? error.message : 'malformed pkt-line stream');
  }
  const first = lines.find((line) => line.kind === 'data');
  const firstText = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';
  if (firstText.startsWith('command=ls-refs')) return v2LsRefs(store, repo, lines);
  if (firstText.startsWith('command=fetch')) return v2Fetch(store, repo, lines);
  // Anything else is a v0 fetch (want/have/shallow/deepen lines in two flush-separated sections).
  return v0Fetch(store, repo, lines);
}

/** v2 ls-refs: HEAD (when symrefs), refs with symref-target/peeled attrs, server-side prefix filter. */
function v2LsRefs(store: Store, repo: Repo, lines: ReturnType<typeof decodePktLines>): GitResponse {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text === 'peel') peel = true;
    else if (text === 'symrefs') symrefs = true;
    else if (text === 'unborn') unborn = true;
    else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (repo.refs.size === 0) {
    if (unborn && keep(headRef)) out.push(`unborn ${headRef}\n`);
  } else {
    if (symrefs && headTip !== undefined && keep('HEAD')) out.push(`${headTip} HEAD symref-target:${headRef}\n`);
    for (const name of sortedRefNames(repo)) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      const peeled = peel ? peelRef(store, repo, oid) : undefined;
      if (peeled !== undefined) line += ` peeled:${peeled}`;
      out.push(`${line}\n`);
    }
  }
  out.push('flush');
  return ok('application/x-git-upload-pack-result', encodePktLines(out));
}

interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

/** Shared fetch selection: which commits/objects to send, and the new shallow boundary. */
function selectFetch(
  store: Store,
  repo: Repo,
  params: FetchParams,
): { objects: GitObject[]; shallow: string[]; unshallow: string[]; wantedRefs: Array<{ oid: string; ref: string }> } {
  const held = store.heldObjects(repo, params.haves, params.shallow);
  // The included set descends past shallow boundaries (deepen exists to cross them); only the
  // depth limit truncates it. The boundaries truncate the HELD set, not this one.
  const distances = store.collectCommits(repo, params.wants, { depth: params.depth });
  // Objects reachable from the included commits, minus what the client holds. Tag tips are sent
  // themselves (their target commit is in the included set via peeling).
  const included = store.reachableObjects(repo, distances.keys());
  for (const want of params.wants) {
    const object = store.getObject(repo, want);
    if (object !== undefined && object.type === 'tag') included.set(want, object);
  }
  const objects: GitObject[] = [];
  for (const [oid, object] of included) {
    if (!held.has(oid)) objects.push(object);
  }
  // New shallow boundary: included commits at the depth limit whose parents were not included,
  // and which the client does not already hold outright.
  const shallow: string[] = [];
  if (params.depth !== undefined) {
    for (const [oid, dist] of distances) {
      if (dist !== params.depth - 1) continue;
      if (held.has(oid)) continue;
      const object = store.getObject(repo, oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parentsIncluded = parseCommit(object.data).parents.every((parent) => distances.has(parent));
      if (!parentsIncluded) shallow.push(oid);
    }
  }
  // Unshallow: old boundaries now fully inside the fetched region (all parents included).
  const unshallow: string[] = [];
  for (const boundary of params.shallow) {
    if (!distances.has(boundary)) continue;
    if (params.depth === undefined) {
      unshallow.push(boundary);
      continue;
    }
    const dist = distances.get(boundary)!;
    if (dist >= params.depth - 1) continue;
    const object = store.getObject(repo, boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const parentsIncluded = parseCommit(object.data).parents.every((parent) => distances.has(parent));
    if (parentsIncluded) unshallow.push(boundary);
  }
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name)!;
    if (params.wants.includes(oid)) wantedRefs.push({ oid, ref: name });
  }
  return { objects, shallow, unshallow, wantedRefs };
}

function parseV2Fetch(lines: ReturnType<typeof decodePktLines>): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) params.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) params.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) params.depth = n;
    }
  }
  return params;
}

function v2Fetch(store: Store, repo: Repo, lines: ReturnType<typeof decodePktLines>): GitResponse {
  const params = parseV2Fetch(lines);
  const selected = selectFetch(store, repo, params);
  const pack = writePack(selected.objects);
  const out: Buffer[] = [];
  out.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'delim']));
  if (params.depth !== undefined || selected.shallow.length > 0 || selected.unshallow.length > 0) {
    const shallowLines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of selected.shallow) shallowLines.push(`shallow ${oid}\n`);
    for (const oid of selected.unshallow) shallowLines.push(`unshallow ${oid}\n`);
    shallowLines.push('delim');
    out.push(encodePktLines(shallowLines));
  }
  const wantedLines: Array<string | 'delim'> = ['wanted-refs\n'];
  for (const ref of selected.wantedRefs) wantedLines.push(`${ref.oid} ${ref.ref}\n`);
  wantedLines.push('delim');
  out.push(encodePktLines(wantedLines));
  out.push(encodePktLines(['packfile\n']));
  out.push(sidebandWrap(pack, 1));
  out.push(PKT_FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(out));
}

function v0Fetch(store: Store, repo: Repo, lines: ReturnType<typeof decodePktLines>): GitResponse {
  const params: FetchParams = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    if (line.kind !== 'data') continue;
    const text = line.payload.toString('utf8').replace(/\n$/, '');
    if (text.startsWith('want ')) {
      const oid = text.slice(5).split(' ')[0];
      if (isObjectId(oid)) params.wants.push(oid);
    } else if (text.startsWith('have ')) params.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) params.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) params.depth = n;
    }
  }
  const selected = selectFetch(store, repo, params);
  const pack = writePack(selected.objects);
  const out: Buffer[] = [];
  const head: Array<string | 'flush'> = ['NAK\n'];
  for (const oid of selected.shallow) head.push(`shallow ${oid}\n`);
  for (const oid of selected.unshallow) head.push(`unshallow ${oid}\n`);
  out.push(encodePktLines(head));
  out.push(sidebandWrap(pack, 1));
  out.push(PKT_FLUSH);
  return ok('application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------------------------------------
// receive-pack: v0 push
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return err(404, 'Not Found');
  // Parse the command section pkt-line by pkt-line until the first flush. Everything after that
  // flush is the pack (binary, not pkt-lines), so the whole body must never be pkt-decoded.
  const commands: PushCommand[] = [];
  let offset = 0;
  let sawFlush = false;
  while (offset + 4 <= body.length) {
    const hex = body.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (hex === '0001') {
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) return err(400, `bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len < 4 || offset + len > body.length) return err(400, 'truncated pkt-line payload');
    const text = body.subarray(offset + 4, offset + len).toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const head = nul >= 0 ? text.slice(0, nul) : text;
    const parts = head.split(' ');
    if (parts.length < 3) return err(400, `bad receive-pack command ${JSON.stringify(head.slice(0, 60))}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    offset += len;
  }
  if (!sawFlush) return err(400, 'receive-pack command list has no flush');
  if (commands.length === 0) return err(400, 'receive-pack needs at least one command');
  const packStart = offset;
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (updatesRef) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'unpack failed: missing pack';
    } else {
      try {
        const parsed = readPack(Buffer.from(packBytes));
        for (const [oid, object] of parsed.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object);
        }
      } catch (error) {
        unpackOk = false;
        unpackDetail = `unpack failed: ${error instanceof Error ? error.message : 'bad pack'}`;
      }
    }
  }
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    reportLines.push(`${applyPushCommand(store, repo, command)}\n`);
  }
  const inner = encodePktLines([...reportLines, 'flush']);
  const bodyOut = Buffer.concat([sidebandWrap(inner, 1), PKT_FLUSH]);
  return ok('application/x-git-receive-pack-result', bodyOut);
}

/** Apply one ref update; returns the report-status line ("ok <ref>" or "ng <ref> <reason>"). */
function applyPushCommand(store: Store, repo: Repo, command: PushCommand): string {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/') || ref.length > 200 || /[\s\x00-\x1f]/.test(ref)) {
    return `ng ${ref} invalid ref`;
  }
  if (!isObjectId(oldOid) || !isObjectId(newOid)) return `ng ${ref} bad object id`;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (oldOid !== current) return `ng ${ref} old value mismatch`;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return `ng ${ref} ref does not exist`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  // The new tip must exist and resolve to a commit (the pack just unpacked it, or it was stored).
  if (store.peelToCommit(repo, newOid) === null) {
    return `ng ${ref} object not found`;
  }
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return `ng ${ref} already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  // Fast-forward only: the new tip must descend from the old tip.
  if (!store.isAncestor(repo, oldOid, newOid)) return `ng ${ref} non-fast-forward`;
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}
