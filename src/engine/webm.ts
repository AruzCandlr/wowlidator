/**
 * Cutting a recording short, in the container, with no encoder.
 *
 * The rule this exists for: **evidence is captured when something went wrong,
 * and it runs from the start of the flow to the step that failed.** A
 * recording of a run that passed is a file nobody opens; a recording that
 * carries on past the failure buries the moment it was kept for.
 *
 * Playwright can only stop recording by closing the context, which is the end
 * of the run — so the trim has to happen afterwards, on the finished file. And
 * there is no ffmpeg here (nor a reason to take one on: this repo already
 * hand-parses ZIP and PDF for exactly one narrow thing each — see
 * `catalog/extract.ts`). Dropping the tail of a WebM needs no encoder anyway:
 * frames are stored in order, and cutting at the end only removes frames that
 * nothing kept still refers to. Cutting at the *start* would be a different
 * problem entirely — every frame after a keyframe depends on it — which is
 * why the segment always begins at zero.
 *
 * **The honesty rule, and it is the same one `extract.ts` follows: never hand
 * back a file we could not verify.** A subtly malformed video is worse than no
 * video — it plays for three seconds, stops, and quietly misrepresents when
 * the run ended. So the result is re-parsed before it is returned, and
 * anything unexpected returns `null`, which the caller reports as "not
 * captured" rather than papering over.
 */

/** Cluster and block ids, and the header fields that have to be rewritten. */
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_SEEK_HEAD = 0x114d9b74;
const ID_INFO = 0x1549a966;
const ID_CLUSTER = 0x1f43b675;
const ID_CUES = 0x1c53bb6b;
const ID_VOID = 0xec;
const ID_TIMECODE = 0xe7;
const ID_TIMECODE_SCALE = 0x2ad7b1;
const ID_DURATION = 0x4489;
const ID_SIMPLE_BLOCK = 0xa3;
const ID_BLOCK_GROUP = 0xa0;

/** Nanoseconds per millisecond — WebM's TimecodeScale is expressed in ns. */
const NS_PER_MS = 1_000_000;

interface Element {
  id: number;
  /** Offset of the id byte. */
  start: number;
  /** Offset of the first content byte. */
  dataStart: number;
  /** Offset one past the last content byte. */
  end: number;
  size: number;
  sizeLen: number;
}

/** Read an EBML element id, which carries its own length in its first byte. */
function readId(buf: Buffer, at: number): { id: number; length: number } | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  let length = 0;
  for (let i = 0; i < 4; i++) {
    if (first & (0x80 >> i)) {
      length = i + 1;
      break;
    }
  }
  if (length === 0 || at + length > buf.length) return null;
  let id = 0;
  for (let i = 0; i < length; i++) id = id * 256 + buf[at + i]!;
  return { id, length };
}

/**
 * Read an EBML variable-length integer.
 *
 * `unknown` is the all-ones encoding, which means "this element runs until
 * something else ends it". A live-muxed stream can contain one, and nothing
 * here can truncate a file it cannot measure — so it is reported rather than
 * guessed past.
 */
function readVint(buf: Buffer, at: number): { value: number; length: number; unknown: boolean } | null {
  const first = buf[at];
  if (first === undefined || first === 0) return null;
  let length = 0;
  for (let i = 0; i < 8; i++) {
    if (first & (0x80 >> i)) {
      length = i + 1;
      break;
    }
  }
  if (length === 0 || at + length > buf.length) return null;
  let value = first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = buf[at + i]!;
    value = value * 256 + byte;
    if (byte !== 0xff) unknown = false;
  }
  return { value, length, unknown };
}

function readElement(buf: Buffer, at: number): Element | null {
  const id = readId(buf, at);
  if (!id) return null;
  const size = readVint(buf, at + id.length);
  if (!size || size.unknown) return null;
  const dataStart = at + id.length + size.length;
  const end = dataStart + size.value;
  if (end > buf.length) return null;
  return { id: id.id, start: at, dataStart, end, size: size.value, sizeLen: size.length };
}

/** Every direct child of a range, in order. */
function children(buf: Buffer, from: number, to: number): Element[] {
  const found: Element[] = [];
  let at = from;
  while (at < to) {
    const element = readElement(buf, at);
    if (!element || element.end > to) break;
    found.push(element);
    at = element.end;
  }
  return found;
}

function readUint(buf: Buffer, element: Element): number {
  let value = 0;
  for (let i = element.dataStart; i < element.end; i++) value = value * 256 + buf[i]!;
  return value;
}

/** Write a VINT of an exact byte width, so a size can be patched in place. */
function writeVint(value: number, width: number): Buffer {
  const out = Buffer.alloc(width);
  let remaining = value;
  for (let i = width - 1; i >= 0; i--) {
    out[i] = remaining % 256;
    remaining = Math.floor(remaining / 256);
  }
  out[0] = out[0]! | (0x80 >> (width - 1));
  return out;
}

/** The narrowest VINT that can hold a value. */
function vint(value: number): Buffer {
  for (let width = 1; width <= 8; width++) {
    if (value < 2 ** (7 * width) - 1) return writeVint(value, width);
  }
  throw new Error('size too large for a VINT');
}

function idBytes(id: number): Buffer {
  const bytes: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from(bytes);
}

/**
 * A block's time relative to its cluster, or `null` if this is not a block.
 *
 * Both spellings are handled: `SimpleBlock`, which is what Playwright's muxer
 * writes, and a `BlockGroup` wrapping a `Block`, which is what anything else
 * might. The layout is the same in both — a track-number VINT, then a signed
 * 16-bit offset.
 */
function blockTime(buf: Buffer, element: Element): number | null {
  let block = element;
  if (element.id === ID_BLOCK_GROUP) {
    const inner = children(buf, element.dataStart, element.end).find((c) => c.id === 0xa1);
    if (!inner) return null;
    block = inner;
  } else if (element.id !== ID_SIMPLE_BLOCK) {
    return null;
  }
  const track = readVint(buf, block.dataStart);
  if (!track) return null;
  const at = block.dataStart + track.length;
  if (at + 2 > block.end) return null;
  return buf.readInt16BE(at);
}

/** Replace a region with a Void element of exactly the same length. */
function voidOut(buf: Buffer, start: number, end: number): void {
  const total = end - start;
  // Two bytes is the smallest Void there is: the id, then a zero-length size.
  if (total < 2) return;
  buf[start] = ID_VOID;
  const payload = total - 2;
  if (payload < 0x7f) {
    buf[start + 1] = 0x80 | payload;
    buf.fill(0, start + 2, end);
    return;
  }
  // A wider size field eats into the payload it is describing.
  const size = writeVint(total - 1 - 8, 8);
  size.copy(buf, start + 1);
  buf.fill(0, start + 9, end);
}

export interface TrimResult {
  data: Buffer;
  /** Where the trimmed recording actually ends, which is the last kept frame. */
  durationMs: number;
}

/**
 * Keep the recording from its start up to `endMs`, and drop the rest.
 *
 * Returns `null` when that cannot be done faithfully — an unrecognised
 * container, a stream whose length is not knowable, a cut that would keep no
 * frames, or a result that fails to re-parse. The caller's contract is to
 * record no video at all in that case.
 */
export function trimWebm(input: Buffer, endMs: number): TrimResult | null {
  try {
    return cut(input, endMs);
  } catch {
    return null;
  }
}

function cut(input: Buffer, endMs: number): TrimResult | null {
  if (endMs <= 0) return null;

  const top = children(input, 0, input.length);
  const header = top.find((e) => e.id === ID_EBML);
  const segment = top.find((e) => e.id === ID_SEGMENT);
  if (!header || !segment) return null;

  const parts = children(input, segment.dataStart, segment.end);
  const info = parts.find((e) => e.id === ID_INFO);
  const clusters = parts.filter((e) => e.id === ID_CLUSTER);
  if (!info || clusters.length === 0) return null;

  const infoParts = children(input, info.dataStart, info.end);
  const scaleElement = infoParts.find((e) => e.id === ID_TIMECODE_SCALE);
  const durationElement = infoParts.find((e) => e.id === ID_DURATION);
  // Cluster and block timecodes are in TimecodeScale units; everything below
  // works in those units so the comparison never crosses a unit boundary.
  const scaleNs = scaleElement ? readUint(input, scaleElement) : NS_PER_MS;
  if (scaleNs <= 0) return null;
  const cutoff = (endMs * NS_PER_MS) / scaleNs;

  const kept: Buffer[] = [];
  let lastTime = -1;
  for (const cluster of clusters) {
    const inner = children(input, cluster.dataStart, cluster.end);
    const timecodeElement = inner.find((e) => e.id === ID_TIMECODE);
    if (!timecodeElement) return null;
    const base = readUint(input, timecodeElement);
    if (base > cutoff) break; // this cluster begins after the cut

    const blocks = inner.filter((e) => blockTime(input, e) !== null);
    const survivors = blocks.filter((block) => base + blockTime(input, block)! <= cutoff);
    if (survivors.length === blocks.length) {
      // Nothing to drop — copy the cluster through untouched, which is both
      // cheaper and safer than rebuilding a structure we do not need to change.
      kept.push(input.subarray(cluster.start, cluster.end));
      for (const block of blocks) lastTime = Math.max(lastTime, base + blockTime(input, block)!);
      continue;
    }
    if (survivors.length === 0) break; // the cut lands before this cluster's first frame

    const body = Buffer.concat([
      input.subarray(timecodeElement.start, timecodeElement.end),
      ...survivors.map((block) => input.subarray(block.start, block.end)),
    ]);
    kept.push(Buffer.concat([idBytes(ID_CLUSTER), vint(body.length), body]));
    for (const block of survivors) lastTime = Math.max(lastTime, base + blockTime(input, block)!);
    break; // everything after this cluster is past the cut
  }

  if (kept.length === 0 || lastTime < 0) return null;

  // Everything before the first cluster is kept byte-for-byte, so the offsets
  // that `SeekHead` and `Cues` hold for `Info`/`Tracks` stay correct. Their
  // own entries do not: `Cues` points at clusters that may be gone, and it
  // moves. Both are dropped rather than rewritten — a player reads the file
  // linearly without them, and a stale pointer is the kind of damage that
  // shows up as a video that plays and lies.
  const head = Buffer.from(input.subarray(0, clusters[0]!.start));
  const seekHead = parts.find((e) => e.id === ID_SEEK_HEAD);
  if (seekHead) voidOut(head, seekHead.start, seekHead.end);

  if (durationElement && durationElement.size === 8) {
    head.writeDoubleBE(lastTime, durationElement.dataStart);
  } else if (durationElement && durationElement.size === 4) {
    head.writeFloatBE(lastTime, durationElement.dataStart);
  }

  const body = Buffer.concat(kept);
  const segmentSize = head.length - segment.dataStart + body.length;
  // Playwright writes the segment size as a full-width VINT, which leaves room
  // to patch it in place. A narrower one would move every byte after it.
  if (segment.sizeLen < 2) return null;
  writeVint(segmentSize, segment.sizeLen).copy(head, segment.dataStart - segment.sizeLen);

  const out = Buffer.concat([head, body]);
  return verify(out, lastTime) ? { data: out, durationMs: Math.round((lastTime * scaleNs) / NS_PER_MS) } : null;
}

/**
 * Re-read what was just written and insist it is a whole WebM.
 *
 * This is the half that lets the caller promise "captured, or not at all".
 * Building the file and trusting it would make every parsing assumption above
 * into a silent risk; reading it back turns each of them into a `null`.
 */
function verify(out: Buffer, expectedLastTime: number): boolean {
  const top = children(out, 0, out.length);
  if (top.length === 0) return false;
  // Every top-level element must account for its bytes exactly, with nothing
  // dangling — the signature of a size that was patched wrongly.
  if (top[top.length - 1]!.end !== out.length) return false;
  const segment = top.find((e) => e.id === ID_SEGMENT);
  if (!segment || segment.end !== out.length) return false;

  const parts = children(out, segment.dataStart, segment.end);
  if (parts.length === 0 || parts[parts.length - 1]!.end !== segment.end) return false;
  if (parts.some((e) => e.id === ID_CUES)) return false;

  const clusters = parts.filter((e) => e.id === ID_CLUSTER);
  if (clusters.length === 0) return false;

  let frames = 0;
  let latest = -1;
  for (const cluster of clusters) {
    const inner = children(out, cluster.dataStart, cluster.end);
    if (inner.length === 0 || inner[inner.length - 1]!.end !== cluster.end) return false;
    const timecodeElement = inner.find((e) => e.id === ID_TIMECODE);
    if (!timecodeElement) return false;
    const base = readUint(out, timecodeElement);
    for (const element of inner) {
      const offset = blockTime(out, element);
      if (offset === null) continue;
      frames += 1;
      latest = Math.max(latest, base + offset);
    }
  }
  return frames > 0 && latest === expectedLastTime;
}
