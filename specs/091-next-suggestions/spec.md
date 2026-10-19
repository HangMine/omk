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
  an error, the user aborted, or the account is near a usage limit
  (**≥ 90% of the current quota window used**, PREREG).

### Stage 2 — probability (local bm25 candidates)

- Score all installed skills (~800) locally with bm25, using the stage-1
  sentence as the query, over skill name + description.
- Keep top-k with **k ≤ 255** and **total candidate tokens ≤ 32k** (Jev limits).
  If the token total is over 32k, reduce k until it fits; **never truncate
  descriptions** (descriptions are up to 1,024 chars,
  `packages/coding-agent/src/core/skills.ts:17` `MAX_DESCRIPTION_LENGTH`).
- Recall is measured first **without** any boost. Only if it is below 99%,
  recall is remeasured **once** with a recency-frequency boost whose formula is
  fixed in the PREREG before any measurement. If it is still below 99%, the Jev
  stage is not built. (See Measurement 1; the two texts must stay identical in
  meaning.)
- Local only, cost 0.

### Stage 3 — Jev (final skill choice)

- TypeSafe `POST https://api.typesafe.ai/v1/systemone`, model pinned
  `jev-1.14.0`, a `choice` question over the stage-2 candidates.
- Response fields used: `choice`, `probabilities`, `confidence`.
- Attach the `!skill:<name>` prefix only if the chosen skill's probability is
  **≥ 0.6** (PREREG threshold); otherwise show the sentence alone.
- The chosen ID must be an installed skill: typed as the candidate ID union
  and re-checked at runtime against the loaded skill list; anything else is
  dropped.
- Plain `fetch`, no SDK, abortable, timeout **1500 ms** (PREREG).
- **Jev unavailable** (no key, timeout, HTTP/parse error): show the suggestion
  **without** a skill prefix. There is **no bm25 top-1 substitute**.

### Skill prefix format

The prefix is the existing `!skill:<name> ` form, the same one the skill picker
inserts (`packages/coding-agent/src/modes/interactive/skill-picker-draft.ts:8,13`
on `af8d32559e`). No `!skills:` form or parser is added.

### History isolation

The stage-1 suggestion request and its response, and the stage-3 Jev request
and response, **never** enter session history, compaction input, or the next
main-turn request. An accepted suggestion enters history only as the user's own
input text, after Tab and an explicit send.

### Late results (PREREG)

A stage-1 sentence or a Jev response that arrives after the user started typing
or sent the next turn is **discarded** (not shown, not logged as shown).

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

1. **Stage-2 recall gate (local, cost 0):**
   - **Labels:** ~100 pairs (next-task sentence → correct skill), authored by a
     human from real skill-usage logs: for each logged skill use, the human
     writes the next-task sentence for that used skill, **without seeing any
     bm25 output**. The label file's sha is pinned in the PREREG before any
     measurement.
   - **Label data rule:** labels are derived from real skill-usage logs. Raw
     session logs never leave the box and never become fixtures. The label
     file is **not committed** to the repo; it stays on the box only, at
     `/workspace/omk-eval-091/labels-<sha256-prefix>.jsonl` (placeholder).
     Human-written sentences that closely copy log text are likewise not
     committed. The spec and PR record only the label file's sha256, the pair
     count N, and aggregate results.
   - **Allowed misses:** once N is fixed, the PREREG writes the allowed miss
     count as an integer, `floor(0.01 × N)` (N = 100 → at most 1 miss).
     Recall passes only if misses ≤ that integer.
   - Recall = correct skill inside the stage-2 candidates at k = 255 (or the
     reduced k that fits 32k). Target **≥ 99%**. Also report candidate token
     count vs 32k.
   - Order: (a) measure **without** boost; (b) only if < 99%, remeasure
     **once** with the recency-frequency boost whose formula was fixed in the
     PREREG beforehand; (c) if still < 99%, **the Jev stage is not built**.
2. Suggestion-request cache-read ratio ≥ the PREREG value.
3. Main-turn cache hit rate does not drop vs base.
4. Extra billed tokens per suggestion: median ≤ 300, p95 ≤ 1000.
5. Suggestion latency p95 ≤ 3 s.
6. Main-turn latency: paired comparison (flag on vs off) with
   `/workspace/omk-bench-analyst/paired_verdict.py` (not a git repo; file
   sha256 `07afdce052895231d2f52f2bb8a5ecaf9cdac353bb04e22a1303972a47211d0f`).
7. Key-input latency p99 not worse than base.
8. Run-log (spec 042, `OMK_RUN_LOG_DIR`): tokens (cached vs billed), latency,
   Jev probability, Tab acceptance, accepted-unedited rate. No text, no key.

### PREREG constants fixed by this spec

| Constant | Value |
| --- | --- |
| Near usage limit (stage-1 skip) | ≥ 90% of quota window used |
| Jev request timeout | 1500 ms |
| Jev probability threshold for `!skill:` | 0.6 |
| Stage-2 recall target | ≥ 99% (at most one boosted remeasure) |
| Allowed recall misses | `floor(0.01 × N)` as an integer, fixed once N is known (N = 100 → ≤ 1) |
| Extra billed tokens | median ≤ 300, p95 ≤ 1000 |
| Suggestion latency | p95 ≤ 3 s |
| Late sentence / Jev response | discarded if user typed or sent |

**Statistical caveat:** pass at ≤ 1 miss in 100 is an observed criterion; its
95% CI lower bound is ~95%, so passing does not prove recall ≥ 99%. Proving 99%
(95% one-sided) needs ~300 labels with 0 misses.
Report Stage-2 recall gate results as observed recall with its exact 95% CI (Clopper-Pearson); never write 'recall ≥ 99%'. Labels stay ~100 (purpose is the build/no-build decision for the Jev stage).

The suggestion cache-read ratio floor and the boost formula are written into
the PREREG before any run.

## Success criterion

Flag off is byte-identical to base with zero extra calls; flag on meets every
PREREG gate above; no non-installed skill is ever suggested.

## Tests (to be written with the implementation)

- Flag off: zero extra calls; main-turn request bytes identical to base.
- History isolation: with the flag on and a suggestion generated (and shown,
  not accepted), the **next main-turn request bytes equal the flag-off
  request bytes**; the suggestion is absent from session entries and
  compaction input.
- Late results: a sentence or Jev response arriving after typing starts or the
  next turn is sent is discarded.
- Stage 1: suggestion request prefix byte-identical to the main prefix,
  instruction only at the end; skip on cold cache / model change / no caching /
  error / abort / near usage limit.
- Stage 2: k ≤ 255, tokens ≤ 32k, k reduced instead of truncating descriptions;
  no boost unless the PREREG remeasure path is taken.
- Stage 3: threshold gate at 0.6; 1500 ms timeout → no prefix; non-installed IDs rejected; no key / timeout / error
  → suggestion without prefix and no bm25 substitute; key never in logs.
- UI: Tab inserts only into empty input, never sends; other keys dismiss and
  cancel; autocomplete Tab behavior unchanged.

## Stage 1 implementation notes

- Modules: `packages/coding-agent/src/core/next-suggestion.ts` (flag, request
  recorder, skip planner, context builder) and
  `packages/coding-agent/src/modes/interactive/next-suggestion-controller.ts`
  (UI); `agent-session.ts` is unchanged. `interactive-mode.ts` has one install
  call; `CustomEditor` gains an `onBeforeInput` hook.
- Flag on wraps the agent stream function with a pass-through recorder; the
  suggestion request reuses the recorded `(model, context, options)` (same
  system prompt, tools, message objects, reasoning and cache options), then
  appends the final assistant message and the instruction.
- "Provider lacks caching" = `cacheRetention: "none"` or the model has no cache
  read price (`cost.cacheRead` 0). "Cache cold" = time since the last main
  request ≥ 5 min (`short`, default) or ≥ 60 min (`long`).
- Usage ≥ 90% reads the active provider's subscription usage windows
  (`loadSubscriptionUsage`); unknown usage does not block.
- Stage 2 will reuse the spec-058 bm25 in `core/skill-search.ts` /
  `core/skill-select-rankers.ts` (no new implementation, no new dependency).
  No Jev call is made in stage 1.

## Rollback

Leave or set `OMK_NEXT_SUGGESTIONS` off (default). Code removal is a revert of
the implementation commits; this spec has no runtime effect.
