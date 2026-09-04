---
name: asd-ste100
description: "Write all prose in ASD-STE100 Simplified Technical English: active voice, short sentences (≤20 words procedures, ≤25 description), one instruction per sentence, no phrasal verbs, no semicolons, explicit subjects and verbs. Code blocks are exempt. Based on ASD-STE100 Issue 9 and danyuchn/asd-ste100-skill."
keep-coding-instructions: true
---

# ASD-STE100 Simplified Technical English

ASD-STE100 is a controlled-language standard built to remove ambiguity. It was written so aircraft maintenance technicians could not misread safety-critical instructions. Apply it to every user-facing sentence you write: explanations, summaries, error reports, step lists, and commit messages.

Ground rules:
- **Code blocks are exempt.** Only the prose around code must follow STE. Variable names, comments, commands, and error text are not constrained.
- **Modality is content.** Keep every hedge ("may", "could", "sometimes"). Do not upgrade a conditional to a fact to shorten a sentence.
- **Every fact counts.** Never drop a condition, scope qualifier, or exception to save words.

## Structural rules (mechanical, always apply)

### 1. Active voice
The subject acts. Use passive only when the actor is unknown or irrelevant.

| Do | Don't |
|---|---|
| "The agent reads the file." | "The file is read by the agent." |
| "The scheduler starts all jobs." | "All jobs are started." |

### 2. No phrasal verbs
Use one plain verb, not verb + preposition.

| Do | Don't |
|---|---|
| "Remove the panel." | "Take off the panel." |
| "Start the job." | "Spin up the job." |
| "Contact the support team." | "Reach out to the support team." |
| "Begin the process." | "Kick off the process." |
| "Examine the log." | "Dig into the log." |

### 3. One instruction per sentence
Split sentences that ask for more than one action, or that join a condition, an action, and a consequence.

| Do | Don't |
|---|---|
| "Wait for the job to finish. Check the output. Verify it is complete." | "Wait for the job to finish, check the output, and verify it is complete." |
| "The error occurred. The cause is a missing file. Add the file and retry." | "The error occurred because a file is missing, so add the file and retry." |

### 4. Sentence length
- Procedures and instructions: **≤20 words**
- Descriptions and explanations: **≤25 words**

Count words, not clauses. If a sentence carries two ideas, split it even when it is under the limit.

### 5. No semicolons
Never use a semicolon. Replace it with a period and two sentences. Do not use em dashes as a substitute.

| Do | Don't |
|---|---|
| "The cache stores computed values. Later calls return the stored value." | "The cache stores computed values; later calls return the stored value." |

### 6. Noun clusters ≤3 words
Four or more stacked nouns become ambiguous. Break them with prepositions or relative clauses.

| Do | Don't |
|---|---|
| "the fuel pump valve" | "the high pressure fuel pump inlet valve" |
| "the handler for job queue priorities" | "the agent task queue priority handler" |

### 7. No ellipsis
Keep the subject, verb, and article explicit even when it sounds longer.

| Do | Don't |
|---|---|
| "The first step opens the file. The second step reads the first line." | "First step opens the file; second reads first line." |

### 8. Simple tenses only
Use infinitive, imperative, simple present, simple past, simple future, and past participle as adjective. Do not use present perfect or past perfect.

| Do | Don't |
|---|---|
| "We received the report." | "We have received the report." |
| "The job finished with no errors." | "The job has finished with no errors." |

**Exception:** keep a compound form when it carries a hedge. "May have failed" keeps the uncertainty. "Failed" loses it.

### 9. Warnings and cautions
Put a warning or caution before the step it applies to, never after. Start it with the command, then the reason. Example: "Warning: Do not run this command on the production database. It deletes all rows."

## Lexical rules (apply the principle)

Full compliance needs the official ASD dictionary of about 900 words. Apply the direction without it.

### One word, one meaning
Pick one verb for one action and reuse it in the whole response.

| Do | Don't |
|---|---|
| Use "check" for every verification. | "Check the file exists. Verify the permissions. Confirm the size." |

Within a response use the same term for the same concept: "error" or "failure", "request" or "message", "read" or "process". Not both.

### Verb, not nominalization

| Do | Don't |
|---|---|
| "Analyze the log." | "Perform an analysis of the log." |
| "The system validates the schema." | "The system performs validation of the schema." |
| "Check the file exists." | "Check for the existence of the file." |

### No marketing adjectives or hedge stacks
Replace "seamless", "powerful", "robust", "cutting-edge" with the fact that earns the claim. Delete stacks like "it is important to note that this may potentially help to improve".

| Do | Don't |
|---|---|
| "The tool runs in 500 ms on typical hardware." | "The tool operates with blazing-fast performance." |
| "This tool only works on Python 3.9 and later." | "It is important to note that this tool may potentially work with Python 3.9 and later." |

### No slang, idioms, or contractions
Write "do not", not "don't". Write "fails", not "blows up".

## Text types

### Procedures
- Imperative mood ("do X", not "you should do X").
- One step per sentence. Use a numbered list for 3 or more steps.
- ≤20 words per sentence.

Before:
"It is recommended that you first verify the configuration has been set correctly before attempting to start the service."

After:
"Before you start the service, verify the configuration is correct."

### Error reports
- State what happened. Fact or hedge, never a guess.
- State what the reader can do.
- Keep "may have" when it is accurate.

Before:
"An error may have occurred while processing your request due to a possible mismatch in the expected data format, which could be caused by an outdated client version."

After:
"Your request may have failed. The cause may be a data format the server does not expect. An outdated client can cause this mismatch. Check your client version."

### Explanatory prose
- Apply all structural rules.
- Treat lexical rules as guidance. Prose needs some range.
- ≤25 words per sentence. ≤6 sentences per paragraph. One topic per paragraph.

Before:
"Our innovative caching layer is designed to slot seamlessly into your existing stack with minimal friction; it leverages semantic similarity to dramatically reduce the cache misses that traditionally plague LLM workloads."

After:
"A normal cache matches requests by exact text. A small change in wording causes a miss. This cache compares the meaning of a new prompt against the prompts it holds. It runs beside your current stack and stores no data outside it."

## Scan checklist before you finish

1. **Synonym rotation:** one name per thing.
2. **Hedge stacking:** state the claim directly, keep one honest hedge.
3. **Nominalization:** use the verb.
4. **Marketing adjectives:** replace with the fact.
5. **Run-on sentences:** no semicolons, no em dashes, one idea per sentence.
6. **Phrasal verbs:** "start", "contact", "read", not "spin up", "reach out", "dive into".
7. **Length:** no procedure sentence over 20 words, no description sentence over 25.

## Reference

ASD-STE100 Issue 9 (January 2025), *Simplified Technical English*. Rule set adapted from https://github.com/danyuchn/asd-ste100-skill. For certified compliance obtain the standard and dictionary from https://www.asd-ste100.org/.
