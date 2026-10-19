---
description: "1.5.5 next-task suggestions with Jev skill selection: default-off flag; cache → bm25 probability → Jev pipeline; PREREG-gated measurement (spec only, no code)"
---

# Feature Specification: next-task suggestions and Jev skill selection

**Specification ID**: `091-next-suggestions`
**Feature Branch**: `spec/091-next-suggestions` from local main `af8d32559e`
**Created**: 2026-10-20
**Status**: Spec only (no code); local commit, not pushed
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: Design decided in the omk harness team room (인호, Tech Lead, OMK, Agent Researcher, Library Scout, PR Architect): pipeline "A" (cache → probability → Jev).
**Target**: 1.5.5
**OMK Preset**: `omk`

**Behavior changes**: none by default (flag off).

## Problem

After a turn the user has to type the next request from scratch and pick a
skill by hand among ~800 installed skills. A short suggestion of the next task,
optionally prefixed with the best-fitting skill, saves that step — but only if
it costs almost nothing, never slows the main turn, and never picks a skill that
is not installed.

## Activation

- New flag `OMK_NEXT_SUGGESTIONS` (env; setting mirror optional), **default off**.
- Flag off: zero extra provider calls, zero Jev calls, and main-turn request
  bytes are byte-identical to base `af8d32559e` (regression test, below).

## Pipeline A

### Stage 1 — cache (next-task sentence)

- After a completed turn, the **selected model** produces exactly one
  next-task sentence via a short background request that reuses the main
  conversation's prompt cache.
- The request prefix is byte-identical to the main turn's cached prefix; the
  suggestion instruction is appended **only at the end**. No skill list is sent
  to the model.
- Skip (no request) when: the cache is cold (TTL elapsed or the model changed
  since the last turn), the provider has no prompt caching, the turn ended in
  an error, the user aborted, or the account is near a usage limit.

### Stage 2 — probability (local bm25 candidates)

- Score all installed skills (~800) locally with bm25, using the stage-1
  sentence as the query, over skill name + description.
- Keep top-k with **k ≤ 255** and **total candidate tokens ≤ 32k** (Jev limits).
  If the token total is over 32k, reduce k until it fits; **never truncate
  descriptions** (descriptions are up to 1,024 chars,
  `packages/coding-agent/src/core/skills.ts:17` `MAX_DESCRIPTION_LENGTH`).
- A recency/frequency boost is **not** in the first build. It is a candidate
  scoring change only if stage-2 recall is below 99% (measured without it,
  since it makes recall depend on session history).
- Local only, cost 0.

### Stage 3 — Jev (final skill choice)

- TypeSafe `POST https://api.typesafe.ai/v1/systemone`, model pinned
  `jev-1.14.0`, a `choice` question over the stage-2 candidates.
- Response fields used: `choice`, `probabilities`, `confidence`.
- Attach the skill prefix only if the chosen skill's probability is
  **≥ the PREREG threshold**; otherwise show the sentence alone.
- The chosen ID must be an installed skill: typed as the candidate ID union
  and re-checked at runtime against the loaded skill list; anything else is
  dropped.
- Plain `fetch`, no SDK, bounded timeout, abortable.
- **Jev unavailable** (no key, timeout, HTTP/parse error): show the suggestion
  **without** a skill prefix. There is **no bm25 top-1 substitute**.

### Skill prefix format (open question)

The room wrote `!skills:`. On `af8d32559e` the existing picker inserts
`!skill:<name> ` (singular;
`packages/coding-agent/src/modes/interactive/skill-picker-draft.ts:8,13`) and
no `!skills:` parser exists. Implementation must use the existing `!skill:`
form unless Tech Lead decides otherwise.

## Data, privacy, and keys

- Sources: <https://docs.typesafe.ai/models>,
  <https://docs.typesafe.ai/introduction/quickstart>,
  <https://typesafe.ai/terms>.
- **Assumptions (unverified):** zero data retention is enterprise-only (DPA
  not read); availability from Korea not verified.
- Sent to Jev: only candidate skill names/descriptions and the suggestion
  sentence. **No session content**, file contents, or tool output.
- Key only from env `TYPESAFE_API_KEY`; never logged, never written to run-log,
  session, fixtures, or commits. A key once posted in a shared room is treated
  as exposed and must be revoked.
- Paid Jev calls (including measurement runs) need 인호's approval in a 1:1
  chat before they run.

## UI

- The suggestion renders as gray placeholder text in an **empty** input.
- **Tab** inserts it into the input only when the input is empty and a
  suggestion exists; it never sends.
- Any other key dismisses the suggestion and cancels a pending generation.
- No conflict with autocomplete. References checked on `af8d32559e`:
  - `packages/tui/src/autocomplete.ts:151-174` (`AutocompleteItem` /
    `AutocompleteProvider` interfaces);
  - `packages/tui/src/keybindings.ts:120` (`tui.input.tab`);
  - `packages/tui/src/components/editor.ts:631-650` (Tab while the
    autocomplete list is open) and `:680-684` (Tab triggers completion when no
    autocomplete state). The suggestion Tab path runs only when the input is
    empty, no autocomplete state exists, and a suggestion is visible;
    otherwise the existing paths are unchanged.
  - Skill shape: `packages/coding-agent/src/core/skills.ts:378-384`
    (`name`, `description`, `filePath`, …).

## Measurement (PREREG before any run; numbers fixed in advance)

1. **Stage-2 recall gate (local, cost 0):** ~100 labeled pairs
   (next-task sentence → correct skill), sha-pinned. Recall = correct skill
   inside the stage-2 candidates at k = 255 (or the reduced k).
   Target **≥ 99%**. Also report candidate token count vs 32k.
   **If recall < 99%, the Jev stage is not built.**
2. Suggestion-request cache-read ratio ≥ the PREREG value.
3. Main-turn cache hit rate does not drop vs base.
4. Extra billed tokens per suggestion: median ≤ 300, p95 ≤ 1000.
5. Suggestion latency p95 ≤ 3 s.
6. Main-turn latency: paired comparison with `paired_verdict.py` (flag on vs off).
7. Key-input latency p99 not worse than base.
8. Run-log (spec 042, `OMK_RUN_LOG_DIR`): tokens (cached vs billed), latency,
   Jev probability, Tab acceptance, accepted-unedited rate. No text, no key.

## Success criterion

Flag off is byte-identical to base with zero extra calls; flag on meets every
PREREG gate above; no non-installed skill is ever suggested.

## Tests (to be written with the implementation)

- Flag off: zero extra calls; main-turn request bytes identical to base.
- Stage 1: suggestion request prefix byte-identical to the main prefix,
  instruction only at the end; skip on cold cache / model change / no caching /
  error / abort / near usage limit.
- Stage 2: k ≤ 255, tokens ≤ 32k, k reduced instead of truncating descriptions.
- Stage 3: threshold gate; non-installed IDs rejected; no key / timeout / error
  → suggestion without prefix and no bm25 substitute; key never in logs.
- UI: Tab inserts only into empty input, never sends; other keys dismiss and
  cancel; autocomplete Tab behavior unchanged.

## Rollback

Leave or set `OMK_NEXT_SUGGESTIONS` off (default). Code removal is a revert of
the implementation commits; this spec has no runtime effect.
