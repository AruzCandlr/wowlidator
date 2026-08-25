/**
 * An agent at the controls while the page is captured.
 *
 * The AX tree that generation and authoring read is a photograph, and the
 * deterministic settles (`load`, `networkidle`, the lazy-content walk, fonts)
 * can only wait for things a heuristic can name. What they cannot do is *look*:
 * a skeleton screen that is "loaded" as far as the network is concerned, a
 * cookie banner covering the controls that matter, a spinner that outlives
 * `networkidle` because the app polls. A model looking at the page can tell
 * "still loading" from "loaded and empty", and that judgement is the accuracy
 * the deterministic pipeline structurally lacks.
 *
 * So, before the capture, the workflow agent briefly takes the browser with a
 * deliberately narrow goal: settle and reveal, never change. The same
 * "prepare, don't perform" contract as the ladder's agent rung — whatever the
 * agent claims, the only thing that counts is the capture that follows it.
 *
 * Bounded hard (`CAPTURE_PILOT_MAX_STEPS`), and a pilot that fails changes
 * nothing: the capture proceeds exactly as it would have without one.
 */

import type { Page } from 'playwright';

import type { AgentRecord } from '../engine/proof-bundle.js';
import type { WorkflowAgent } from '../orchestrator/workflow-agent.js';

/**
 * Small on purpose: the pilot is a pre-flight check, not an exploration. Two
 * or three actions cover the cases it exists for — wait out a spinner,
 * dismiss a banner, scroll once — and anything needing more is the probe's or
 * the author's job, not the shutter's.
 */
export const CAPTURE_PILOT_MAX_STEPS = 5;

export const CAPTURE_PILOT_GOAL =
  'The page is about to be captured (accessibility tree and screenshot) so tests can be ' +
  'written from it. Make the capture accurate, then stop:\n' +
  '- If the page is still loading — spinners, skeleton placeholders, empty regions that ' +
  'are clearly about to fill — wait, then look again.\n' +
  '- If an overlay is covering the content (cookie banner, promo dialog, tour popup), ' +
  'dismiss it via its close/accept control.\n' +
  '- Scroll down one screen and back up once, so lazily rendered content exists.\n' +
  'Call finish as soon as the page looks fully rendered and unobstructed.\n' +
  'Do NOT navigate to another page, do NOT submit any form, do NOT change any data, and ' +
  'do NOT open menus — a separate probe handles disclosures. You are steadying the ' +
  'camera, not exploring.';

/**
 * Let `agent` steady the page, then hand control back. Never throws, and the
 * caller captures afterwards regardless — the pilot's account is context, the
 * capture is the evidence.
 */
/**
 * URLs this process has already settled with a look-only pilot (every action
 * was a wait/scroll/finish — nothing on the page was changed). A second visit
 * to the same URL renders the same way, so the deterministic settles suffice
 * and the 2–5 model turns are not paid again. A pilot that had to ACT — click
 * a banner away, dismiss a dialog — is never memoized: in a fresh context the
 * obstruction may be back.
 */
const settledUrls = new Map<string, AgentRecord>();

/** The AGENT_ACTIONS that observe without changing the page. */
const LOOK_ONLY_ACTIONS = new Set(['scroll', 'wait', 'finish']);

function settleKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

export async function pilotCapture(
  page: Page,
  agent: WorkflowAgent,
  onLog?: (line: string) => void,
): Promise<AgentRecord | null> {
  const key = settleKey(page.url());
  const remembered = settledUrls.get(key);
  if (remembered) {
    onLog?.('capture pilot: page already settled this session — skipping the model turns');
    return { ...remembered, turns: 0, latencyMs: 0, inputTokens: 0, outputTokens: 0 };
  }
  try {
    onLog?.('agent steadying the page before capture…');
    const record = await agent.run(page, CAPTURE_PILOT_GOAL);
    onLog?.(
      `capture pilot ${record.success ? 'settled the page' : 'gave up'} after ${record.turns} ` +
        `turn(s): ${record.summary}`,
    );
    if (
      record.success &&
      record.actions.every((a) => LOOK_ONLY_ACTIONS.has(a.action ?? ''))
    ) {
      settledUrls.set(key, record);
    }
    return record;
  } catch (error) {
    // `run` is documented never to throw; belt and braces, because a pilot
    // must never be the reason a capture fails.
    onLog?.(`capture pilot failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
