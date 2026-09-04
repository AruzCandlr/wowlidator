/**
 * Sequence diagrams as images — the vision transcription in front of the
 * deterministic sequence path. All offline: `DiagramTranscriberModel` is one
 * method, so the interesting behaviour — parse-gated acceptance, the informed
 * re-ask, the loud refusal, the disclosure note — runs against a stub. Whether
 * a real vision model reads real pixels is a live-model fact, same tier as
 * every other `Llm*Model`.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  DIAGRAM_IMAGE_EXTENSIONS,
  DiagramImageError,
  MAX_SVG_SOURCE_CHARS,
  TRANSCRIBE_ATTEMPTS,
  isDiagramImage,
  transcribeDiagramImage,
  type DiagramTranscriberModel,
  type TranscriptionRequest,
} from '../src/catalog/diagram-image.js';

const VALID_MERMAID = [
  'sequenceDiagram',
  '    actor U as HR Admin',
  '    participant A as API',
  '    U->>A: POST /api/benefit-plans',
  '    A-->>U: 200 ok',
].join('\n');

let dir: string;
let imagePath: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wow-diagram-image-'));
  imagePath = join(dir, 'flow.png');
  // The stub never reads pixels; the file only has to exist and have bytes.
  await writeFile(imagePath, Buffer.from('not-really-a-png'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function stubModel(
  responses: readonly { mermaid: string; unreadable?: string }[],
): DiagramTranscriberModel & { seen: TranscriptionRequest[] } {
  let call = 0;
  const model = {
    id: 'stub:vision',
    seen: [] as TranscriptionRequest[],
    async transcribe(request: TranscriptionRequest) {
      model.seen.push(request);
      const response = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      return { mermaid: response.mermaid, unreadable: response.unreadable ?? '', inputTokens: 10, outputTokens: 5 };
    },
  };
  return model;
}

describe('isDiagramImage', () => {
  it('recognises exactly the supported image containers, svg included', () => {
    for (const extension of DIAGRAM_IMAGE_EXTENSIONS) {
      assert.ok(isDiagramImage(`diagram${extension}`), extension);
    }
    assert.ok(isDiagramImage('diagram.svg'));
    assert.equal(isDiagramImage('diagram.mmd'), false);
    assert.equal(isDiagramImage('diagram.pdf'), false);
  });
});

describe('transcribing an svg', () => {
  it('hands the model the markup, never pixels', async () => {
    const svgPath = join(dir, 'flow.svg');
    await writeFile(svgPath, '<svg data-diagram-type="SEQUENCE"><text>hello</text></svg>', 'utf8');
    const model = stubModel([{ mermaid: VALID_MERMAID }]);
    const result = await transcribeDiagramImage(svgPath, model);
    assert.equal(result.mermaid, VALID_MERMAID);
    const request = model.seen[0]!;
    assert.equal(request.image, undefined);
    assert.match(request.svgSource ?? '', /data-diagram-type="SEQUENCE"/);
    // The disclosure says what was actually read.
    assert.match(result.note, /reading of the SVG markup/);
  });

  it('refuses an svg too large to be a prompt, naming the fix', async () => {
    const bigPath = join(dir, 'huge.svg');
    await writeFile(bigPath, `<svg>${'x'.repeat(MAX_SVG_SOURCE_CHARS)}</svg>`, 'utf8');
    const model = stubModel([{ mermaid: VALID_MERMAID }]);
    await assert.rejects(transcribeDiagramImage(bigPath, model), /Export it as PNG/);
    assert.equal(model.seen.length, 0, 'refused before any model is asked');
  });
});

describe('transcribeDiagramImage', () => {
  it('accepts a transcript only after the deterministic parser takes it', async () => {
    const model = stubModel([{ mermaid: VALID_MERMAID }]);
    const result = await transcribeDiagramImage(imagePath, model);
    assert.equal(result.mermaid, VALID_MERMAID);
    assert.equal(result.doc.messages.length, 2, 'the parsed doc rides along as proof it parses');
    assert.equal(model.seen.length, 1);
    assert.equal(model.seen[0]!.mediaType, 'image/png');
  });

  it('discloses in the note that a model read pixels, naming the model', async () => {
    const result = await transcribeDiagramImage(imagePath, stubModel([{ mermaid: VALID_MERMAID }]));
    assert.match(result.note, /stub:vision/);
    assert.match(result.note, /reading of pixels/);
  });

  it('carries what the model could not read into the note, never into the diagram', async () => {
    const result = await transcribeDiagramImage(
      imagePath,
      stubModel([{ mermaid: VALID_MERMAID, unreadable: 'the third arrow label is blurred' }]),
    );
    assert.match(result.note, /the third arrow label is blurred/);
  });

  it('re-asks once with the parse error as feedback, and the better attempt wins', async () => {
    const model = stubModel([{ mermaid: 'flowchart TD\nA-->B' }, { mermaid: VALID_MERMAID }]);
    const result = await transcribeDiagramImage(imagePath, model);
    assert.equal(result.mermaid, VALID_MERMAID);
    assert.equal(model.seen.length, 2);
    const feedback = model.seen[1]!.feedback;
    assert.ok(feedback && feedback.length === 1, 'the second ask must know what was refused');
  });

  it('treats a transcript the parser mostly ignored as refused, not accepted', async () => {
    // The live failure: the model reads the picture correctly but writes
    // multi-word participant names with no alias, so the parser "parses"
    // while ignoring most lines — 1 claim survives out of 5. Majority-lost
    // must go back as feedback, not forward as a catalog.
    const mostlyIgnored = [
      'sequenceDiagram',
      '    participant Web App',
      '    participant HR Admin',
      '    HR Admin->>Web App: open the page',
      '    Web App-->>HR Admin: render the list',
      '    A->>B: kept',
    ].join('\n');
    const model = stubModel([{ mermaid: mostlyIgnored }, { mermaid: VALID_MERMAID }]);
    const result = await transcribeDiagramImage(imagePath, model);
    assert.equal(result.mermaid, VALID_MERMAID);
    assert.equal(model.seen.length, 2);
    assert.match(model.seen[1]!.feedback![0]!, /ignored/);
  });

  it('judges "mostly ignored" from the full counter, not the capped notes', async () => {
    // The gap the counter closed: the per-line "line N ignored" notes cap at
    // 8, so a transcript with 9+ parsed messages and ANY number of lost lines
    // used to sail through the notes-based check — 10 messages read, 20 lines
    // of the diagram silently gone. The judgement now reads doc.ignored.
    const messages = Array.from({ length: 9 }, (_, i) => `    A->>B: kept ${i}`);
    const lost = Array.from({ length: 20 }, (_, i) => `    Payment Service->>Fraud Check: lost ${i}`);
    const mostlyLost = [
      'sequenceDiagram',
      '    participant A',
      '    participant B',
      ...messages,
      ...lost,
    ].join('\n');
    const model = stubModel([{ mermaid: mostlyLost }, { mermaid: VALID_MERMAID }]);
    const result = await transcribeDiagramImage(imagePath, model);
    assert.equal(result.mermaid, VALID_MERMAID, 'the clean second attempt wins');
    assert.equal(model.seen.length, 2, 'the mostly-lost transcript was refused, not accepted');
    assert.match(model.seen[1]!.feedback![0]!, /ignored 20 line\(s\)/);
    assert.match(model.seen[1]!.feedback![0]!, /read only 9 message\(s\)/);
  });

  it('refuses loudly when no transcript parses, carrying the last transcript', async () => {
    const model = stubModel([{ mermaid: 'not a diagram at all' }]);
    await assert.rejects(
      transcribeDiagramImage(imagePath, model),
      (error: Error) =>
        error instanceof DiagramImageError &&
        error.message.includes(`${TRANSCRIBE_ATTEMPTS} attempt(s)`) &&
        error.message.includes('not a diagram at all'),
    );
    assert.equal(model.seen.length, TRANSCRIBE_ATTEMPTS, 'every budgeted ask is spent before refusing');
  });

  it('refuses a path that is not a diagram image before any model is asked', async () => {
    const model = stubModel([{ mermaid: VALID_MERMAID }]);
    await assert.rejects(
      transcribeDiagramImage(join(dir, 'flow.mmd'), model),
      /not a diagram image/,
    );
    assert.equal(model.seen.length, 0);
  });
});
