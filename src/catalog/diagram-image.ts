/**
 * A sequence diagram as an image — an exported PNG, a screenshot of a design
 * doc, a photographed whiteboard. The deterministic parser cannot read pixels,
 * so a vision-capable model transcribes the image into Mermaid *text* first,
 * and everything after that is the existing deterministic path: one claim per
 * message, the lane table, the claims gate.
 *
 * This is the one place a model sits in front of the sequence pipeline, and
 * two rules keep its eyes honest — both descendants of `extract.ts`'s "never
 * hand back text that is not in the document":
 *
 * - **The transcript must parse before it is accepted.** `parseSequenceDiagram`
 *   throws naming the line; that error goes back to the model once as
 *   feedback (the healer's `rejected` seam, applied here), and a second
 *   failure is a loud error carrying the last transcript — never a guess
 *   passed downstream.
 * - **The transcript is written to disk and disclosed, never silent.** The
 *   caller writes `<image>.transcribed.mmd` next to the image and the note on
 *   the extracted document says a model read pixels — so the claims gate a
 *   person already walks through is also the place they can diff the
 *   transcript against the drawing. Downstream cites the transcript, which is
 *   the run's actual input; the image itself proves nothing to a parser.
 *
 * Routing reuses the `generator` role (a large input in, a small flat shape
 * out — the `src/repair/` precedent). The default generator provider is
 * vision-capable; one that is not fails with the model's label in the
 * message, an environment fact about routing, not about the diagram.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import { z } from 'zod';

import {
  LlmFactory,
  generateStructuredForModel,
  type ModelSource,
} from '../providers/llm-factory.js';
import { parseSequenceDiagram, type SequenceDoc } from './sequence.js';

/** Raster containers accepted as sequence diagrams — sent to the model as pixels. */
const RASTER_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

/**
 * An SVG render (PlantUML, mermaid-cli exports) is markup, not pixels — vision
 * endpoints do not take it, and handing it to the claims model as prose is the
 * live failure this module now guards against (30 ungated "claims" from raw
 * XML, no lane table, no boundary, 4× splitting). So an .svg goes through the
 * SAME transcription gate as a picture, with the markup as the model's input:
 * the transcript must parse, lands on disk for review, is sticky across
 * phases, and the deterministic path owns everything after it.
 */
export const DIAGRAM_SVG_EXTENSION = '.svg';

/** Anything bigger should be rasterized first — a prompt is not a file store. */
export const MAX_SVG_SOURCE_CHARS = 400_000;

export const DIAGRAM_IMAGE_EXTENSIONS = [
  ...Object.keys(RASTER_MEDIA_TYPES),
  DIAGRAM_SVG_EXTENSION,
];

export function isDiagramImage(name: string): boolean {
  return DIAGRAM_IMAGE_EXTENSIONS.includes(extname(name).toLowerCase());
}

export class DiagramImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiagramImageError';
  }
}

export interface TranscriptionRequest {
  /** Raster bytes, for pixel formats. Absent for an SVG. */
  image?: Uint8Array | undefined;
  mediaType?: string | undefined;
  /** The SVG markup, for `.svg` — the model reads it as text, not pixels. */
  svgSource?: string | undefined;
  /**
   * Why earlier transcripts were refused — the parse errors, verbatim. The
   * value of a retry is entirely in the ask that knows what was rejected.
   */
  feedback?: readonly string[] | undefined;
}

export interface TranscriptionResult {
  /** The Mermaid `sequenceDiagram` text the model read off the image. */
  mermaid: string;
  /** What the model could not make out — '' when everything was legible. */
  unreadable: string;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
}

/** The injectable seam — one method, so the tests run offline. */
export interface DiagramTranscriberModel {
  readonly id: string;
  transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
}

/* ------------------------------------------------------------- the model */

// Flat, every field required, empty string for "nothing" — the structured-
// output convention for free tiers (see CLAUDE.md).
const TranscriptionSchema = z.object({
  mermaid: z.string(),
  unreadable: z.string(),
});

const SYSTEM_PROMPT = [
  'You transcribe sequence diagrams from images into Mermaid sequenceDiagram text.',
  '',
  'Rules — transcription, not interpretation:',
  '- Transcribe ONLY what is drawn. Never add, merge, reorder, or complete messages the image does not show.',
  '- Participants exactly as labelled in the image, left-to-right. Use "actor" for a stick figure, "participant" for everything else.',
  '- Give every participant a short one-word alias and use ONLY the alias in message lines: "participant W as Web App" then "H->>W: open the page". A name containing spaces on a message line is unreadable to the parser.',
  '- Messages in top-to-bottom order, with the arrow direction the image draws (solid ->>, dashed/return -->>).',
  "- Keep each message's own label text verbatim, including method names, paths, and status codes.",
  '- alt/else, opt, loop and par frames as drawn, with their guard labels verbatim.',
  '- The "mermaid" field must start with "sequenceDiagram".',
  '- Anything you cannot read (blur, handwriting, cropping) goes in "unreadable", named specifically — never guessed into the diagram. Use an empty string when everything was legible.',
  '- When given SVG source instead of a picture, the same rules apply to the diagram it DRAWS: participants are the lifeline headers, message order follows the y coordinates, one drawn arrow is one message with its nearby label text joined into one line. Ignore styling, defs, and any element that draws no participant, arrow, frame or label.',
].join('\n');

export interface LlmDiagramTranscriberOptions {
  factory?: LlmFactory | undefined;
  maxOutputTokens?: number | undefined;
}

/** The only place this module resolves a model; everything else takes the seam. */
export class LlmDiagramTranscriber implements DiagramTranscriberModel {
  readonly #factory: LlmFactory;
  readonly #source: ModelSource;
  readonly #maxOutputTokens: number;

  constructor(options: LlmDiagramTranscriberOptions = {}) {
    this.#factory = options.factory ?? new LlmFactory();
    this.#source = { factory: this.#factory, role: 'generator' };
    // 8192, like the flow author's: a tall diagram's transcript arrives as
    // escaped JSON, and a reasoning model's thinking bills against the same
    // budget — 4096 was cut off mid-transcript on a real 6-lane diagram.
    this.#maxOutputTokens = options.maxOutputTokens ?? 8192;
  }

  /**
   * Lazy, like LlmFlowRepairModel's and LlmDataModel's: constructing the class
   * must never itself demand an API key — a process that never transcribes
   * never needs one resolvable.
   */
  get id(): string {
    return this.#factory.forRole('generator').id;
  }

  async transcribe(request: TranscriptionRequest): Promise<TranscriptionResult> {
    const lines = [
      request.svgSource !== undefined
        ? 'Transcribe the sequence diagram drawn by the SVG source below into Mermaid sequenceDiagram text.'
        : 'Transcribe the attached sequence diagram image into Mermaid sequenceDiagram text.',
    ];
    if (request.feedback?.length) {
      lines.push(
        '',
        'Your previous transcript was REFUSED by the diagram parser. Fix exactly this — do not repeat it:',
        ...request.feedback.map((entry) => `  - ${entry}`),
      );
    }
    if (request.svgSource !== undefined) {
      lines.push('', 'SVG source:', request.svgSource);
    }
    const { object, inputTokens, outputTokens } = await generateStructuredForModel(this.#source, {
      modelLabel: this.id,
      schema: TranscriptionSchema,
      system: SYSTEM_PROMPT,
      prompt: lines.join('\n'),
      ...(request.image !== undefined && request.mediaType !== undefined
        ? { images: [{ data: request.image, mediaType: request.mediaType }] }
        : {}),
      maxOutputTokens: this.#maxOutputTokens,
    });
    return {
      mermaid: object.mermaid,
      unreadable: object.unreadable,
      inputTokens,
      outputTokens,
    };
  }
}

/* --------------------------------------------------------- the pipeline */

export const TRANSCRIBE_ATTEMPTS = 2;

export interface TranscribedDiagram {
  /** The accepted Mermaid text — the run's actual input, written to disk by the caller. */
  mermaid: string;
  /** The same text, already parsed — proof it parses is part of acceptance. */
  doc: SequenceDoc;
  /** Disclosure for the document note / claims file: a model read pixels. */
  note: string;
  unreadable: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Image → accepted Mermaid transcript, or a loud error. Acceptance means the
 * deterministic parser takes it — a transcript that does not parse earns one
 * informed re-ask, and a second refusal throws with the last transcript in
 * the message so a person can see what the model saw.
 */
export async function transcribeDiagramImage(
  path: string,
  model: DiagramTranscriberModel,
  onLog?: ((line: string) => void) | undefined,
): Promise<TranscribedDiagram> {
  const extension = extname(path).toLowerCase();
  const isSvg = extension === DIAGRAM_SVG_EXTENSION;
  const mediaType = RASTER_MEDIA_TYPES[extension];
  if (!isSvg && !mediaType) {
    throw new DiagramImageError(
      `not a diagram image: ${basename(path)} (expected ${DIAGRAM_IMAGE_EXTENSIONS.join(' ')})`,
    );
  }
  let source: Pick<TranscriptionRequest, 'image' | 'mediaType' | 'svgSource'>;
  if (isSvg) {
    const svgSource = await readFile(path, 'utf8');
    if (svgSource.length > MAX_SVG_SOURCE_CHARS) {
      throw new DiagramImageError(
        `${basename(path)} is ${svgSource.length.toLocaleString('en-US')} chars of SVG — too large to hand a model as markup. Export it as PNG and catalog that instead.`,
      );
    }
    source = { svgSource };
  } else {
    source = { image: new Uint8Array(await readFile(path)), mediaType };
  }
  const readsWhat = isSvg ? 'the SVG markup' : 'pixels';

  const feedback: string[] = [];
  let lastTranscript = '';
  let inputTokens = 0;
  let outputTokens = 0;
  for (let attempt = 1; attempt <= TRANSCRIBE_ATTEMPTS; attempt += 1) {
    onLog?.(
      attempt === 1
        ? `reading ${basename(path)} with ${model.id} — a model transcribes ${readsWhat} to Mermaid, then the ordinary deterministic path takes over…`
        : `transcript did not parse — asking again with the error (attempt ${attempt}/${TRANSCRIBE_ATTEMPTS})…`,
    );
    const result = await model.transcribe({
      ...source,
      ...(feedback.length > 0 ? { feedback } : {}),
    });
    lastTranscript = result.mermaid;
    inputTokens += result.inputTokens ?? 0;
    outputTokens += result.outputTokens ?? 0;
    try {
      const doc = parseSequenceDiagram(result.mermaid);
      // Parsing is necessary, not sufficient: a transcript whose lines the
      // parser mostly IGNORED (unaliased multi-word names is the live case)
      // "parses" while silently losing the diagram. Majority-lost is a
      // refusal with the ignored lines as feedback, not an acceptance.
      // The judgement reads the parser's own counter, not the notes list —
      // the notes cap per-line entries at 8, so counting them would let a
      // transcript with 50 lost lines sail through once 8+ messages parsed.
      if (doc.ignored > doc.messages.length) {
        const ignoredNotes = doc.notes.filter((entry) => /line \d+ ignored|more line\(s\) ignored/.test(entry));
        feedback.push(
          `the parser ignored ${doc.ignored} line(s) and read only ${doc.messages.length} message(s) — ${ignoredNotes.join('; ')}`,
        );
        continue;
      }
      const note =
        `transcribed from ${basename(path)} by ${model.id} — a model's reading of ${readsWhat}, not the drawing itself; ` +
        `review the .transcribed.mmd against the image before approving claims` +
        (result.unreadable !== '' ? `. The model could not read: ${result.unreadable}` : '');
      return {
        mermaid: result.mermaid,
        doc,
        note,
        unreadable: result.unreadable,
        inputTokens,
        outputTokens,
      };
    } catch (error) {
      feedback.push((error as Error).message);
    }
  }
  throw new DiagramImageError(
    `could not transcribe ${basename(path)} into a parseable sequence diagram after ` +
      `${TRANSCRIBE_ATTEMPTS} attempt(s) — ${feedback.join('; ')}.\nLast transcript:\n${lastTranscript}`,
  );
}
