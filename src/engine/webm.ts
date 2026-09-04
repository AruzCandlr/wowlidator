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

// ---------------------------------------------------------------------------
// Condensing: keep the moments something happened, drop the idle between.
//
// The film of a run is the run's wall clock: a 25 fps constant-rate recording
// in which every ladder timeout, model call and hydration settle is minutes
// of a page doing nothing. Measured (2026-09-04, three catalog films under
// `reports/*-media`): 25.0 fps throughout, a keyframe every 128 frames
// (5.12 s, libvpx's default), each keyframe 60–90 KB of a 960-wide frame and
// each idle second another 5–8 KB of "nothing changed" frames — so a 59 s film
// with twelve moments in it weighed 1.6 MB, and most of that was the idle.
//
// There is still no encoder here (see the header above), and that fixes what
// "condense" can mean: only frames that can be decoded from what is kept may
// be kept. A VP8 frame decodes against the frames before it back to the last
// keyframe, so every kept span begins at a keyframe — the most recent one
// at or before the moment asked for — and runs, frame for frame in source
// order, through the moment and its dwell. Nothing is synthesised and nothing
// is reordered; what changes is the clock: the frames between that keyframe
// and the moment (the pre-roll the codec forces on us) are packed into a
// short burst (`IDLE_BURST_MS`), the last frame before each cut is held
// (`CUT_HOLD_MS`), and the frames outside every span are gone. The mapping from source
// time to output time rides the result so per-step seeks can follow it.
// ---------------------------------------------------------------------------

/** A span of the source film, in ms, that must survive at real speed. */
export interface KeptWindow {
  fromMs: number;
  toMs: number;
}

/**
 * One linear stretch of the condensed film mapped back to the source clock.
 * `idle` marks a codec-forced pre-roll played fast rather than a moment.
 */
export interface CondenseSegment {
  sourceFromMs: number;
  sourceToMs: number;
  outputFromMs: number;
  outputToMs: number;
  idle: boolean;
}

export interface CondenseResult {
  data: Buffer;
  /** Playing time of the condensed film — the last kept frame's output time. */
  durationMs: number;
  /** Playing time of the source film, for the report to say what was dropped. */
  sourceDurationMs: number;
  frames: number;
  sourceFrames: number;
  segments: CondenseSegment[];
}

/**
 * Longest a run of idle frames — the pre-roll a keyframe forces, or the
 * gap between two moments that share one — plays for, ms.
 *
 * Replaces the 8× fast-forward (2026-09-04, PL_07_06's film): at 8× a
 * 25 fps stream became 5 ms frames, which a browser presents at most one in
 * three of, so every pre-roll was a 0.2–0.6 s strobe of the page jumping
 * about. Idle frames still have to be decoded (a VP8 frame refers to every
 * frame back to its keyframe), so they are packed into this budget — about
 * four presented frames at most — which reads as a cut, not a scrub. Short
 * idle runs whose real pace fits the budget keep their real pace.
 */
export const IDLE_BURST_MS = 160;

/**
 * How long the last frame before a cut is held, ms: before a new span opens
 * on its keyframe, and before a moment gives way to idle. A jump between two
 * page states with one frame period between them reads as a glitch; a beat
 * on the state that was reached, then the jump, reads as an edit. Free —
 * a frame's duration is the gap to the next timestamp.
 */
export const CUT_HOLD_MS = 400;

/**
 * Two moments closer than this (window edge to window edge) are kept as one
 * stretch at real speed: the film between them is the pointer travelling
 * from one control to the next, and dropping it left a 2-frame sliver of
 * "idle" between them (PL_07_06: source 3560–3600 → 5 ms of output).
 */
export const BRIDGE_MS = 1_000;

export interface CondenseOptions {
  bridgeMs?: number | undefined;
  holdMs?: number | undefined;
  burstMs?: number | undefined;
}

interface Frame {
  /** Byte range of the whole SimpleBlock element. */
  start: number;
  end: number;
  /** Offset of the 16-bit relative timecode inside the element. */
  timeAt: number;
  /** Absolute time in TimecodeScale units. */
  time: number;
  key: boolean;
}

function uintBytes(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  do {
    bytes.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

/** Every video frame of the film, in order, with its absolute time. */
function readFrames(input: Buffer, clusters: Element[]): Frame[] | null {
  const frames: Frame[] = [];
  for (const cluster of clusters) {
    const inner = children(input, cluster.dataStart, cluster.end);
    const timecodeElement = inner.find((e) => e.id === ID_TIMECODE);
    if (!timecodeElement) return null;
    const base = readUint(input, timecodeElement);
    for (const element of inner) {
      if (element.id === ID_BLOCK_GROUP) return null; // not Playwright's muxer; not handled
      if (element.id !== ID_SIMPLE_BLOCK) continue;
      const track = readVint(input, element.dataStart);
      if (!track) return null;
      const timeAt = element.dataStart + track.length;
      if (timeAt + 3 > element.end) return null;
      const flags = input[timeAt + 2]!;
      frames.push({
        start: element.start,
        end: element.end,
        timeAt,
        time: base + input.readInt16BE(timeAt),
        key: (flags & 0x80) !== 0,
      });
    }
  }
  return frames;
}

/**
 * Map a source moment to where it now sits in the condensed film.
 *
 * Inside a kept segment the mapping is linear; a moment that was dropped maps
 * to the start of the first segment after it (the next thing that happened),
 * and one past the last kept frame to the end.
 */
export function mapToCondensed(segments: readonly CondenseSegment[], sourceMs: number): number {
  let last = 0;
  for (const segment of segments) {
    if (sourceMs < segment.sourceFromMs) return segment.outputFromMs;
    if (sourceMs <= segment.sourceToMs) {
      const span = segment.sourceToMs - segment.sourceFromMs;
      if (span <= 0) return segment.outputFromMs;
      const ratio = (sourceMs - segment.sourceFromMs) / span;
      return Math.round(segment.outputFromMs + ratio * (segment.outputToMs - segment.outputFromMs));
    }
    last = segment.outputToMs;
  }
  return last;
}

/**
 * Keep only the frames around `windows` and re-time them into one short film.
 *
 * Returns `null` on the same terms as `trimWebm`: an unreadable container, a
 * block layout this reader does not handle, no frame kept, or a result that
 * fails to re-parse. The caller then falls back to the whole film — a bigger
 * true record beats a smaller doubtful one.
 */
export function condenseWebm(
  input: Buffer,
  windows: readonly KeptWindow[],
  options: CondenseOptions = {},
): CondenseResult | null {
  try {
    return condense(input, windows, {
      bridgeMs: options.bridgeMs ?? BRIDGE_MS,
      holdMs: options.holdMs ?? CUT_HOLD_MS,
      burstMs: options.burstMs ?? IDLE_BURST_MS,
    });
  } catch {
    return null;
  }
}

/** Every frame of a film, with its time in ms and whether it is a keyframe. */
export interface FrameIndexEntry {
  timeMs: number;
  key: boolean;
}

/**
 * The film's frames as a player would see them, or `null` for a container
 * this reader does not handle. For tests and reports: whether timestamps
 * advance, and whether every cut lands on a keyframe, are facts about the
 * file, not about the code that wrote it.
 */
export function frameIndex(input: Buffer): FrameIndexEntry[] | null {
  try {
    const top = children(input, 0, input.length);
    const segment = top.find((e) => e.id === ID_SEGMENT);
    if (!segment) return null;
    const parts = children(input, segment.dataStart, segment.end);
    const info = parts.find((e) => e.id === ID_INFO);
    const scaleElement = info && children(input, info.dataStart, info.end).find((e) => e.id === ID_TIMECODE_SCALE);
    const scaleNs = scaleElement ? readUint(input, scaleElement) : NS_PER_MS;
    const frames = readFrames(input, parts.filter((e) => e.id === ID_CLUSTER));
    return frames ? frames.map((f) => ({ timeMs: (f.time * scaleNs) / NS_PER_MS, key: f.key })) : null;
  } catch {
    return null;
  }
}

function condense(
  input: Buffer,
  windows: readonly KeptWindow[],
  { bridgeMs, holdMs, burstMs }: { bridgeMs: number; holdMs: number; burstMs: number },
): CondenseResult | null {
  if (!(bridgeMs >= 0) || !(holdMs >= 0) || !(burstMs >= 0)) return null;
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
  const scaleNs = scaleElement ? readUint(input, scaleElement) : NS_PER_MS;
  if (scaleNs <= 0) return null;
  const toUnits = (ms: number) => (ms * NS_PER_MS) / scaleNs;
  const toMs = (units: number) => (units * scaleNs) / NS_PER_MS;

  const frames = readFrames(input, clusters);
  if (!frames || frames.length === 0) return null;
  for (let i = 1; i < frames.length; i++) {
    if (frames[i]!.time < frames[i - 1]!.time) return null; // never reorder; refuse a film that is not in order
  }
  const sourceLast = frames[frames.length - 1]!.time;

  // Windows: clipped to the film, sorted, merged where they overlap.
  const wanted = windows
    .map((w) => ({ from: Math.max(0, toUnits(w.fromMs)), to: Math.min(sourceLast, toUnits(w.toMs)) }))
    .filter((w) => w.to >= w.from)
    .sort((a, b) => a.from - b.from);
  // Bridged too: a gap shorter than `bridgeMs` is the pointer travelling
  // between two controls, kept at real speed rather than cut to a sliver.
  const bridge = toUnits(bridgeMs);
  const merged: { from: number; to: number }[] = [];
  for (const w of wanted) {
    const prev = merged[merged.length - 1];
    if (prev && w.from <= prev.to + bridge) prev.to = Math.max(prev.to, w.to);
    else merged.push({ ...w });
  }
  if (merged.length === 0) return null;

  // Each window's span opens at the last keyframe at or before it — the
  // frames from there to the window are decodable and nothing earlier is
  // needed. Spans that reach each other merge into one contiguous run.
  const spans: { from: number; to: number }[] = [];
  for (const w of merged) {
    let anchor: Frame | undefined;
    for (const frame of frames) {
      if (frame.time > w.from) break;
      if (frame.key) anchor = frame;
    }
    if (!anchor) {
      anchor = frames.find((f) => f.key && f.time >= w.from && f.time <= w.to);
      if (!anchor) continue;
    }
    const prev = spans[spans.length - 1];
    if (prev && anchor.time <= prev.to) prev.to = Math.max(prev.to, w.to);
    else spans.push({ from: anchor.time, to: w.to });
  }
  if (spans.length === 0) return null;

  const inWindow = (time: number) => merged.some((w) => time >= w.from && time <= w.to);

  // The kept frames, each with its standing: a moment (inside a window) or
  // idle (the pre-roll a keyframe forces, or a gap between two moments on
  // one keyframe). Gathered first, because an idle run's pacing depends on
  // how long the run is.
  const kept: { frame: Frame; out: number; idle: boolean; span: number }[] = [];
  let spanIndex = 0;
  for (const frame of frames) {
    while (spanIndex < spans.length && frame.time > spans[spanIndex]!.to) spanIndex += 1;
    if (spanIndex >= spans.length) break;
    const span = spans[spanIndex]!;
    if (frame.time < span.from) continue;
    kept.push({ frame, out: 0, idle: !inWindow(frame.time), span: spanIndex });
  }
  if (kept.length === 0 || !kept[0]!.frame.key) return null;

  // Re-time. A moment frame keeps its distance from the frame before it; the
  // last frame before a cut — a new span, or a moment giving way to idle —
  // is held `holdMs`; an idle run of n frames is packed to fit `burstMs`
  // (never faster than one unit a frame, never slower than it happened).
  // Output times are integers in TimecodeScale units, strictly increasing.
  const hold = Math.max(1, Math.round(toUnits(holdMs)));
  const burst = toUnits(burstMs);
  let runEnd = -1;
  let runSpacing = 1;
  for (let i = 0; i < kept.length; i++) {
    const entry = kept[i]!;
    const previous = kept[i - 1];
    if (!previous) {
      entry.out = 0;
      continue;
    }
    const realGap = Math.max(1, entry.frame.time - previous.frame.time);
    if (previous.span !== entry.span || (!previous.idle && entry.idle)) {
      entry.out = previous.out + hold;
      continue;
    }
    if (!entry.idle) {
      entry.out = previous.out + realGap;
      continue;
    }
    if (i > runEnd) {
      // The start of an idle run: measure it once and pace it to the budget.
      runEnd = i;
      while (runEnd + 1 < kept.length && kept[runEnd + 1]!.idle && kept[runEnd + 1]!.span === entry.span) runEnd += 1;
      const gaps = runEnd - i + 1;
      runSpacing = Math.max(1, Math.floor(burst / gaps));
    }
    entry.out = previous.out + Math.min(realGap, runSpacing);
  }
  if (kept.length === 0 || !kept[0]!.frame.key) return null;

  // Clusters: a new one whenever the relative timecode would overflow the
  // signed 16 bits a SimpleBlock carries, or a span begins (which also keeps
  // every cluster opening on a keyframe when a span does).
  const relLimit = Math.min(32_000, Math.floor(toUnits(30_000)));
  const clustersOut: Buffer[] = [];
  let clusterBase = -1;
  let blocks: Buffer[] = [];
  const flush = () => {
    if (blocks.length === 0) return;
    const body = Buffer.concat([
      Buffer.concat([idBytes(ID_TIMECODE), vint(uintBytes(clusterBase).length), uintBytes(clusterBase)]),
      ...blocks,
    ]);
    clustersOut.push(Buffer.concat([idBytes(ID_CLUSTER), vint(body.length), body]));
    blocks = [];
  };
  for (const { frame, out } of kept) {
    if (clusterBase < 0 || out - clusterBase > relLimit || frame.key) {
      flush();
      clusterBase = out;
    }
    const copy = Buffer.from(input.subarray(frame.start, frame.end));
    copy.writeInt16BE(out - clusterBase, frame.timeAt - frame.start);
    blocks.push(copy);
  }
  flush();

  const head = Buffer.from(input.subarray(0, clusters[0]!.start));
  const seekHead = parts.find((e) => e.id === ID_SEEK_HEAD);
  if (seekHead) voidOut(head, seekHead.start, seekHead.end);
  const lastTime = kept[kept.length - 1]!.out;
  if (durationElement && durationElement.size === 8) {
    head.writeDoubleBE(lastTime, durationElement.dataStart);
  } else if (durationElement && durationElement.size === 4) {
    head.writeFloatBE(lastTime, durationElement.dataStart);
  }
  const body = Buffer.concat(clustersOut);
  const segmentSize = head.length - segment.dataStart + body.length;
  if (segment.sizeLen < 2) return null;
  writeVint(segmentSize, segment.sizeLen).copy(head, segment.dataStart - segment.sizeLen);
  const out = Buffer.concat([head, body]);
  if (!verify(out, lastTime)) return null;

  // The clock map: one segment per maximal run of kept frames from one span
  // with the same standing (pre-roll or moment) — coarse enough to ride the
  // bundle, exact enough that a seek lands on the frame it names.
  const segments: CondenseSegment[] = [];
  for (let i = 0; i < kept.length; i++) {
    const entry = kept[i]!;
    const previous = kept[i - 1];
    const current = segments[segments.length - 1];
    if (current && previous && previous.span === entry.span && previous.idle === entry.idle) {
      current.sourceToMs = Math.round(toMs(entry.frame.time));
      current.outputToMs = Math.round(toMs(entry.out));
    } else {
      segments.push({
        sourceFromMs: Math.round(toMs(entry.frame.time)),
        sourceToMs: Math.round(toMs(entry.frame.time)),
        outputFromMs: Math.round(toMs(entry.out)),
        outputToMs: Math.round(toMs(entry.out)),
        idle: entry.idle,
      });
    }
  }

  return {
    data: out,
    durationMs: Math.round(toMs(lastTime)),
    sourceDurationMs: Math.round(toMs(sourceLast)),
    frames: kept.length,
    sourceFrames: frames.length,
    segments,
  };
}
