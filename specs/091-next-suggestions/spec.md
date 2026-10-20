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
skill by hand among the installed skills. A short suggestion of the next task,
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

- Score all skills in the catalog (see Measurement 1) locally with bm25, using the stage-1
  sentence as the query, over skill name + description.
- Keep top-k with **k ≤ 255** and **total candidate tokens ≤ 32k** (Jev limits).
  If the token total is over 32k, reduce k until it fits; **never truncate
  descriptions** (descriptions are up to 1,024 chars,
  `packages/coding-agent/src/core/skills.ts:17` `MAX_DESCRIPTION_LENGTH`).
- Recall is measured first **without** any boost. Only if the k = 25 gate fails (see Measurement 1),
  recall is remeasured **once** with a recency-frequency boost whose formula is
  fixed in the PREREG before any measurement. If it still fails, the Jev
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
   - **bm25 implementation:** reuse the spec 058 implementation already on
     base (`core/skill-search.ts`, `skill-select-rankers.ts`). No new bm25 code
     and no new dependencies; implementation and recall measurement run the
     same code.
   - **Catalog:** this box's real selectable skill set, deduplicated by name,
     excluding skill folders inside PR worktrees (e.g. `omk-prfix-18`).
     Measured **catalog v2**: 223 deduplicated skills, of which **217 are
     model-selectable** (the catalog used); name-list sha256
     `25f25cda08c1b668ec4da0ed8a5214a4e4cc5eef8b5a46182ae48ed3af18abe6`
     = name list of **all 223** catalog skills; the **217 model-selectable**
     name list sha256 is
     `79ee30417aff3591e445b8d2b3d0a440b28da3411370dbcaefd1f90d095913da`
     (both: sorted names joined by `\n` plus a trailing `\n`). File
     `catalog-v2.json` sha256
     `ce30f5f6a617bcd24be4116eb3f1a06623d0c0a82570ab80c5bfc005228c448c`
     (all fixed in the PREREG). The spec-050 1,191 set
     (`/workspace/omk-skill-baseline/env/s1191`) is synthetic (copies +
     fixtures) and is **not** used. If 인호 provides a real ~800-skill catalog
     name list, recall is re-measured on it once before the paid Jev stage.
   - **Gate set (set B, synthetic):** a uniform random sample of **100
     skills** from the 217-skill catalog (equal probability, no per-folder
     grouping), seed **20261020** (fixed in the PREREG), drawn with
     `random.Random(20261020).sample` over the 217 names. **Sample v2**:
     `sample-v2.json` sha256
     `bd6338801ad7582328e2012765ec30ba5dd24d6ce9a5ae2861c3f6366c81c59e`,
     posted to the room **before** any sentence is written.
     For each sampled skill, Agent Researcher writes one next-task sentence
     from the SKILL.md **body only**. The author **never sees bm25 output**.
   - **Gate labels (EN set):** the gate is graded on a **new English set**
     written fresh from the SKILL.md bodies (not translated from KO). Banned
     words, checked by script: (1) words of the skill name; (2) body-unique
     words (commands/paths); (3) the top-5 IDF description words, computed by
     script over the 217-skill catalog. Fixed in the PREREG before any EN
     sentence is written: `check_labels_en.py` sha256
     `17b358c806e8baed96501e5cb35ef2a822d29600642dc85436201889029d5672`;
     `banned-en-v1.json` sha256
     `d14463c84dcd9ceb07481ca21e807d3c3adb03d52d99812137c5781068d3636e`;
     `fm.py` (frontmatter parser) sha256
     `418f6416a7402a65573da029dd15232f999c8e4b5241f69cb3c508e2dd4ae6ca`.
     Body-unique words are counted over the 217 selectable skills (same set as
     the bm25 catalog and IDF N). The banned list covers the 100 sampled skills
     and is byte-reproducible; the 223-based `38274cd1…` list is obsolete and
     unused.
   - **KO set v1 (report only, not a gate):** `labels-v1.jsonl` sha256
     `b13f512542e469aa2e9e5e235aa31bafbbf2f3d2b2ff6d44f477676fdd6cee93`
     (100 answerable + 10 no-answer).
   - **Overlapping pairs** (e.g. code-review / review-and-ship, flight-booking /
     airline playbooks): misses are flagged separately but still counted.
     Thin skills stay in the sample.
   - **Label author:** agent (Agent Researcher), separate from the bm25
     implementer; has never seen bm25 output. If 인호 writes labels himself,
     those take priority.
   - **No-answer items:** 10 extra situations with gold = none. They are
     **excluded from recall** and used only to check that Jev does not attach
     a skill (probability < 0.6 → no prefix). Reported separately.
   - **Set A (reference only, not a gate):** the 86 bench-derived entries
     (`label-sources.jsonl`, sha256
     `53ec93610d8f9fa7241da781e7b4d76d01d998cc6fc828e9e405a55b6f390e0e`;
     5 skills, 77 code-review), deduplicated with code-review kept at 1 per
     task. Reported separately as an auxiliary metric only.
   - **Label data rule:** raw session logs never leave the box and never
     become fixtures. Label files are **not committed**; they stay on the box
     only, under `/workspace/omk-eval-091/`. The spec, room, and PR record only
     sha256, counts, and aggregate results. The gate-set label sha256 is fixed
     in the PREREG and confirmed by Tech Lead **before** any measurement.
   - **Allowed misses:** `floor(0.01 × N)` over the answerable items
     (N = 100 → at most 1 miss). Recall passes only if misses ≤ that integer.
   - Recall = correct skill inside the stage-2 candidates at a given k (or
     the reduced k that fits 32k); the gate k is 25 (below). Also report candidate token
     count vs 32k. Recall and candidate token count are also reported at
     k = 10, 25, 50, 255; the gate criterion is unchanged.
   - Because 217 < 255, recall at k = 255 is trivially 100% (every skill is a
     candidate).
   - **Gate k (decided by Tech Lead before any measurement):** the gate is
     judged at **k = 25**. Pass iff misses ≤ `floor(0.01 × N)` (N = 100 → ≤ 1)
     **and** candidate tokens ≤ 32k. k = 10, 50, 255 are reported for
     reference only. Report observed recall with its exact Clopper-Pearson 95%
     CI; never write a "≥ 99%" claim.
   - **Baseline arm (PREREG):** no bm25; all 217 skills sent to Jev. Measured
     size (name + description per skill, omk's `estimateTokens` chars/4
     heuristic, `compaction.ts`): **11,852 tokens** total (47,406 chars), ≤ 32k;
     per skill max 251, median 57. Reported alongside the bm25 arm.
   - **Default path:** bm25 k = 25 candidates, then Jev. The missed-skill risk
     is bounded by the k = 25 gate (≤ `floor(0.01 × N)` misses).
   - **Baseline arm timing and switch rule (fixed before any measurement):**
     the "all 217 skills to Jev" baseline is measured only in the paid Jev
     stage. On the same 100 sentences, if the all-skills arm gets **≥ 5 more**
     gold skills correct than the bm25 k = 25 arm, the default switches to
     all-skills; otherwise the bm25 path is kept.
   - **Paired reporting:** report discordant counts b (bm25 right, all-217
     wrong) and c (all-217 right, bm25 wrong) with an exact two-sided McNemar
     p-value (binomial on b + c, p = 0.5). The switch rule above is unchanged
     and decides; p is reporting only.
   - Order: (a) measure **without** boost; (b) only if the k = 25 gate fails, remeasure
     **once** with the recency-frequency boost whose formula was fixed in the
     PREREG beforehand; (c) if it still fails, **the Jev stage is not built**.
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
9. **Usefulness:** 0 real skill uses were found in the 993 local sessions, so
   the feature's usefulness metric is the **Tab acceptance rate**. The
   implementation PR body must state this.

### PREREG constants fixed by this spec

| Constant | Value |
| --- | --- |
| Near usage limit (stage-1 skip) | ≥ 90% of quota window used |
| Jev request timeout | 1500 ms |
| Jev probability threshold for `!skill:` | 0.6 |
| Stage-2 recall gate | k = 25: misses ≤ `floor(0.01 × N)` and candidate tokens ≤ 32k (at most one boosted remeasure) |
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

## Known risks

- Gate labels are synthetic and agent-written (Agent Researcher), not
  human-written; recall on set B may not reflect real usage.
- 0 real skill uses in 993 sessions: no real usage distribution exists.
- With a 217-skill catalog, k = 255 includes all skills, so recall at k = 255
  proves little (hence the k = 25 gate). An option is to skip bm25 and send all skills to
  Jev (within the 32k token limit).
- Reasoning-on suggestion requests use `maxTokens = thinking budget + 128`
  (off: 128). A real-provider check is a paid run, pending 인호's 1:1
  approval.
- Korean suggestion text may break bm25 lexical match against the English
  catalog (KO set v1 shows this). Mitigation (English search keywords) is out
  of Stage 1 scope.

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
  request ≥ `SHORT_CACHE_TTL_MS` 5 min (`short`, default) or ≥
  `LONG_CACHE_TTL_MS` 60 min (`long`); tests cover 1 ms before, at, and 1 ms
  after each boundary.
- The suggestion request differs from the main request only in `maxTokens`
  and its own abort signal. Reasoning is not disabled: with reasoning off,
  `maxTokens = 128` (`SUGGESTION_MAX_TOKENS`); with reasoning on,
  `maxTokens = thinking budget + 128`. The reply is still cut to 200
  characters.
- Usage ≥ 90% reads the active provider's subscription usage windows
  (`loadSubscriptionUsage`), only with the flag on, at most once per settled
  turn, in the background after `prompt_settled` (main-turn timing and request
  bytes unchanged). Fail closed: an error, a timeout (`USAGE_CHECK_TIMEOUT_MS`
  2 s), or a quota source that returns no windows skips the suggestion. A
  provider with no quota source at all (pay-per-token) counts as no quota
  window and proceeds.
- Stage 2 will reuse the spec-058 bm25 in `core/skill-search.ts` /
  `core/skill-select-rankers.ts` (no new implementation, no new dependency).
  No Jev call is made in stage 1.

## Rollback

Leave or set `OMK_NEXT_SUGGESTIONS` off (default). Code removal is a revert of
the implementation commits; this spec has no runtime effect.
