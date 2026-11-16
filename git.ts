// Git primitives from scratch: SHA-1 objects, trees/commits/tags, packfiles and pkt-lines.
// Stdlib only (node:crypto, node:zlib). No git binary, no network.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
/** Largest sideband data chunk: pkt-line (4) + band byte (1) + data <= PKT_LINE_MAX. */
export const SIDEBAND_CHUNK = PKT_LINE_MAX - 5;

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

const SHA40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return SHA40.test(value);
}

/** SHA-1 over the git object header "<type> <len>\0" + data. */
export function oidOf(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function hashObject(type: ObjType, data: Buffer): GitObject & { oid: string } {
  return { type, data, oid: oidOf(type, data) };
}

/** Git's tree sort: directories compare as name + '/'. Byte-wise, like the kit's client. */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  /** Full identity line without timestamp, e.g. "ada iversen <adaiversen@example.invalid>". */
  readonly author: string;
  readonly committer: string;
  readonly timestamp: number;
  /** Stored verbatim (no newline appended): the REST surface echoes it exactly. */
  readonly message: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('buildCommit needs a valid tree id');
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('buildCommit needs valid parent ids');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; timestamp: number; message: string }): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
  ];
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------------------------
// packfiles (v2, full objects only; the conformance client never sends deltas)
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile v2 from plain objects. Trailer is SHA-1 over everything before it. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 32) return false;
  return pack.subarray(pack.length - 20).toString('hex') === packChecksum(pack);
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
}

/** Parse a packfile; verifies the trailer. Delta entries are rejected (never sent by the client). */
export function readPack(pack: Buffer): PackReadResult {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has a bad magic');
  if (!verifyPackChecksum(pack)) throw new Error('pack trailer checksum mismatch');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= end) throw new Error('pack ends before its declared object count');
    const first = pack[offset];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let cursor = offset + 1;
    while ((pack[cursor - 1] & 0x80) !== 0) {
      size |= (pack[cursor] & 0x7f) << shift;
      shift += 7;
      cursor += 1;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta objects in a received pack are not supported');
    const type = CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    // inflateSync with {info:true} reports exactly how many input bytes the zlib stream consumed,
    // so the next object's header starts at the right offset however the pack orders its entries.
    const inflated = inflateSync(pack.subarray(cursor, end), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    const data = inflated.buffer;
    const next = cursor + inflated.engine.bytesWritten;
    if (data.length !== size) throw new Error('pack object size mismatch');
    if (next <= cursor || next > end) throw new Error('pack object stream end is out of range');
    objects.set(oidOf(type, data), { type, data });
    offset = next;
  }
  return { version, declaredCount, objects };
}

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PktLine = { readonly kind: 'data'; readonly payload: Buffer } | { readonly kind: 'flush' } | { readonly kind: 'delim' };

/** One pkt-line: 4 hex length chars (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  if (len > PKT_LINE_MAX) throw new Error(`pkt-line of ${len} bytes exceeds ${PKT_LINE_MAX}`);
  const prefix = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([prefix, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(lines: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Decode a whole pkt-line stream. Throws on any malformed framing (garbage kills the request, not the server). */
export function decodePktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line length');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (hex === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (hex === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len < 4 || len > PKT_LINE_MAX) throw new Error(`bad pkt-line length ${len}`);
    if (offset + len > buf.length) throw new Error('truncated pkt-line payload');
    out.push({ kind: 'data', payload: Buffer.from(buf.subarray(offset + 4, offset + len)) });
    offset += len;
  }
  return out;
}

/** Split a byte stream into pkt-line frames (e.g. a report-status stream inside sideband band 1). */
export function decodePktLinesFromData(buf: Buffer): PktLine[] {
  return decodePktLines(buf);
}

/** Wrap bytes as sideband band-1 pkt-lines (chunked to the pkt-line maximum). */
export function sidebandWrap(data: Buffer, band = 1): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    const framed = Buffer.concat([Buffer.from([band]), chunk]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}
