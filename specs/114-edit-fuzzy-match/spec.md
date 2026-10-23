# Spec 114: `OMK_EDIT_FUZZY_MATCH`: staged, unique-only indentation-tolerant edit matching

Status: draft (spec only, no code). Base: omk `a5127044a9` (main after #247).
Candidate 2 of the 107 A/B queue (Agent Researcher order: truncate-middle, **edit fuzzy-indent**, compaction).
Implementation is gated (see Gate); until then this spec is the only deliverable.

## Problem

The edit tool (`packages/coding-agent/src/core/tools/edit.ts`, `edit-diff.ts`) already has
**two** match stages, always on:

- Stage 1, exact: `fuzzyFindText` (`edit-diff.ts:236`) tries `content.indexOf(oldText)`.
- Stage 2, normalized: `normalizeForFuzzyMatch` (`edit-diff.ts:34`) = NFKC + `trimEnd()` per
  line + smart quotes / Unicode dashes / special spaces → ASCII, searched in
  `buildNormalizedContentMap(content).normalized` (`:140`) and mapped back with
  `mapNormalizedSpanToOriginal` (`:198`).

So trailing whitespace and Unicode punctuation already match today. What does **not** match:

1. **Leading-indent drift.** `oldText` with the right lines but wrong indentation (tabs vs
   spaces, 2 vs 4, one level off) → `getNotFoundError` (`:286`). spec 107's run log already
   classifies this as `indent_only` (`edit-match-observe.ts:70`, `matchesIgnoringIndent`).
2. **Uniqueness is checked only for exact text.** `applyEditsToNormalizedContent` (`:333`)
   calls `countOccurrences(baseContent, edit.oldText)` (`:280`, exact `indexOf` loop,
   `:365-368`). A stage-2 match that has two normalized candidates is silently applied to the
   first one. (Existing behaviour; with the flag on we close it, see D2/Q2.)

The model then re-reads the file and retries, costing a turn and tokens.

## Reference

- Codex CLI, `openai/codex` (**Apache-2.0**, repo ships `NOTICE`), commit
  `e6ebdfe00b520e21ed50ac0362656f32dd64d2fc`:
  [`codex-rs/apply-patch/src/seek_sequence.rs`](https://github.com/openai/codex/blob/e6ebdfe00b520e21ed50ac0362656f32dd64d2fc/codex-rs/apply-patch/src/seek_sequence.rs)
  `seek_sequence(lines, pattern, start, eof)`: line-wise, decreasing strictness:
  exact → `trim_end` → `trim` → `normalise` (trim + dash/quote/space → ASCII). Returns the
  **first** index at the first stage that hits; it does not check uniqueness.
- Aider, `Aider-AI/aider` (**Apache-2.0**), commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c`:
  [`aider/coders/search_replace.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/search_replace.py)
  `flexible_search_and_replace` (`:565`) tries strategies with preprocessors; `relative_indent`
  (`:239`) re-expresses lines as indent deltas so a block can match at another indent level and
  the replacement is re-indented to the file.

**Idea only by default.** omk takes the stage order from Codex and the "re-indent the
replacement to the file" idea from Aider, written fresh in TS. If any code is ported verbatim
or near-verbatim, the new file gets an Apache-2.0 header naming the source file and commit, and
`NOTICE` gets an entry (Codex and/or Aider). Library Scout checks this on the PR.

## Change (flag on)

`OMK_EDIT_FUZZY_MATCH=1` (read per call from `process.env`; unset/anything else = off).

Per edit, in `applyEditsToNormalizedContent`, stages run in order; the **first stage with ≥1
candidate decides**:

| stage | name | compare | span |
|---|---|---|---|
| 1 | `exact` | `content.indexOf(oldText)` (today) | char |
| 2 | `trailing_ws` | per line `trimEnd()` | line-wise |
| 3 | `trim` | per line `trim()` (leading indent ignored) | line-wise, whole lines only |
| 4 | `unicode` | stage 3 + NFKC + quote/dash/space fold (reuse `foldFuzzyChar`, `:105`) | line-wise |

Rules:

- **Unique only.** At the deciding stage, count all candidates (non-overlapping scan over the
  whole file, not first-hit like Codex). Exactly 1 → apply. ≥2 → fail with the existing
  `getDuplicateError` (`:297`) text plus ` (matched at stage <name>)`. No lower stage is tried
  after a stage finds ≥2.
- **0 at every stage** → existing `getNotFoundError` text, plus the hint
  ` (no match at any stage: exact, trailing_ws, trim, unicode)`.
- Stages 3-4 match **whole lines** only: `oldText` is split on `\n`; a candidate is a run of
  `k` consecutive file lines. Leading/trailing empty lines of `oldText` are significant at
  stage 1-2 and trimmed at 3-4 (Aider `strip_blank_lines`), documented in tests.
- **Re-indent (stage 3/4).** Compute `delta` = common leading-whitespace prefix of the
  matched file lines vs of `oldText` lines. Replace that prefix in each `newText` line that
  starts with the `oldText` prefix by the file's prefix; lines that do not start with it are
  left as written. If the file block mixes tabs and spaces differently per line, no re-indent:
  `newText` is used as written (and stage recorded). Never touch text outside the matched span.
- **Line endings / BOM:** unchanged path. `edit.ts` already does `stripBom` →
  `detectLineEnding` → `normalizeToLF` → apply → `restoreLineEndings`; stages run on the LF
  text, so CRLF files stay CRLF.
- **Overlap / no-op** checks (`:379-389`, `getNoChangeError`) unchanged, using the matched span.
- Multi-edit calls: each edit decides its own stage; all must succeed or none is written
  (today's all-or-nothing).

### Flag off

Byte-identical to `a5127044a9`: same match result, same error strings, same diff/details, same
tool description and schema. Stage 2 today (combined trim-end + Unicode) stays as is when off.

### Logging

spec 107 `edit-match.jsonl` already records `matchStages` (1 = exact, 2 = fuzzy) via
`editMatchObserver.stages` (`edit-match-observe.ts`), called from `edit.ts:196`
(`logSuccess`) and `:186` (`logFailure`). Flag on: the applier returns the stage per edit and
the observer logs it instead of recomputing: values `1..4` as in the table, plus
`fuzzyFlag: true`. On failure add `stage` of the duplicate decision when reason is
`multiple_matches`. Flag off: lines unchanged (golden
`test/fixtures/edit-match-observe/golden-main.json` stays green). No file text or paths, only
enums/numbers/hash (spec 107 rule).

### Tool description

Unchanged in v1 (so the first request payload is identical; see A/B step 2).

### Out of scope

`apply_patch` tool (Codex `parser.rs`), window edit (SWE-agent), `write` tool, user-side
edits, any edit-distance / diff-match-patch matching (Aider `dmp_apply`).

## Code integration points (at `a5127044a9`)

| file | function | change |
|---|---|---|
| `src/core/tools/edit-diff.ts` | `applyEditsToNormalizedContent` (`:333`) | take `{ fuzzyStages: boolean }`; call new `findStagedMatch` when on; return `stages: number[]` in `AppliedEditsResult` (`:220`) |
| `src/core/tools/edit-diff.ts` (or new `edit-stage-match.ts`) | new `findStagedMatch(content, oldText): { stage, candidates: {index,length}[] }`, `reindentReplacement` | stages 2-4, line-wise |
| `src/core/tools/edit-diff.ts` | `getNotFoundError` / `getDuplicateError` (`:286`, `:297`) | optional stage suffix (only when on) |
| `src/core/tools/edit-diff.ts` | `computeEditsDiff` (`:555`) | same flag so preview == applied |
| `src/core/tools/edit.ts` | `execute` (`:122` def; apply ≈`:175-196`) | read flag, pass option, pass stages to `logSuccess` |
| `src/core/tools/edit-match-observe.ts` | `logSuccess`, `stages` | accept stages from applier when present |
| `NOTICE` | — | only if code is ported |
| README / env docs | flag list | document flag, "default off" |

## Tests (unit)

New `packages/coding-agent/test/spec114-edit-fuzzy-match.test.ts`:

1. Flag off: all `edit-match-observe-cases.ts` cases + indent-drift fixtures → result, error
   string, file bytes identical to `a5127044a9` (golden).
2. On, exact match → stage 1, same bytes as off.
3. On, trailing-whitespace drift → stage 2, applied, file trailing whitespace outside span kept.
4. On, indent drift (4 spaces in file, 2 in `oldText`) → stage 3, `newText` re-indented to 4.
5. On, tabs in file, spaces in `oldText` → stage 3, replacement uses tabs.
6. On, nested block: `newText` adds a deeper line → relative indent preserved.
7. On, stage 3 with 2 candidates → duplicate error with `(matched at stage trim)`; file unchanged.
8. On, stage 1 unique but stage 3 would have 2 → stage 1 applies (first deciding stage wins).
9. On, stage 2 with 2 normalized candidates → duplicate error (closes today's first-hit bug).
10. On, Unicode quotes/dashes + indent drift → stage 4, original Unicode outside span kept.
11. On, CRLF file + BOM → stage 3 apply, output still CRLF and BOM, no mixed endings.
12. On, multi-edit: one stage-1 + one stage-3 edit, and a variant where the second fails →
    nothing written.
13. On, partial-line `oldText` with indent drift → not matched at stage 3 (whole lines only).
14. Run log: on → `matchStages` values 1..4 and `fuzzyFlag`; off → golden lines unchanged.
15. `computeEditsDiff` preview equals the applied diff for cases 3-6, 10.

Keep green: `edit-match-observe.test.ts`, `edit-tool-legacy-input.test.ts`,
`edit-tool-no-full-redraw.test.ts`, full `npm run check`.

## Gate

Implementation starts only if Agent Researcher counts **≥ 3 distinct failed tasks** that have
an `edit-match.jsonl` failure with `reason: "indent_only"` **and no later successful edit of
the same `pathHash` in the same session/task** (from the 107 A/B run logs, free models).
< 3 → spec stays merged as draft, no code. Count, log paths and SHA are posted in the room.

## A/B plan

Owner: Bench Analyst; method: Agent Researcher (shared 107 rules).

1. Build A = `a5127044a9` (or main at impl time), B = spec 114 head, in two dirs of equal
   path length, same Node 22, `env -u TYPESAFE_API_KEY`, `OMK_TRUST_PROJECT=0`, temp HOME.
2. **Diff the first request payload first** (one task, B flag on). Must be identical (tool
   description unchanged); any diff stops the A/B.
3. Run B = `OMK_EDIT_FUZZY_MATCH=1`, A = unset; **66 tasks × n ≥ 5** per arm, same model, interleaved.
4. Primary: pass-rate B − A, **task-clustered 95% CI, lower bound > −3pt**.
5. Cost: mean tokens B/A **≤ 1.10×**, wall time B/A **≤ 1.25×**.
6. Secondary: edit failures per task by reason, stage histogram (B), retries after
   `indent_only`, wrong-location edits (stage ≥3 edits later reverted on the same file).
7. Free models only unless 인호 posts a dollar cap.
8. Report baseline SHA, B SHA, model, n, CI, ratios, secondary counts, raw log path. No
   performance wording in CHANGELOG without this result ("flag, default off").

## Open questions (Tech Lead)

- **Q1** Include stage 4 (`unicode`) in v1? Today's stage 2 already folds Unicode (with
  trim-end), so stage 4 only adds "Unicode + indent". Proposal: yes, it is cheap and reuses
  `foldFuzzyChar`; or drop it to keep v1 minimal.
- **Q2** Multi-candidate at stage 2: flag on fails instead of today's first-hit. OK to change
  that only under the flag, and fix flag-off separately (own PR) or leave it?
- **Q3** Edit tool only? (Not `computeEditsDiff` callers outside the tool, not workers'
  custom tools.) Proposal: edit tool + its preview only.
- **Q4** Re-indent `newText` (Aider style) or use `newText` as written? Proposal: re-indent,
  fallback as-written on mixed tabs/spaces.
- **Q5** Tool description: leave unchanged (payload-identical A/B) or add one line about
  indentation tolerance in a follow-up?
- **Q6** Should a hit at stage ≥3 add a short note to the tool result (e.g.
  `matched ignoring indentation`) so the model learns? It changes model input in B; proposal:
  no in v1, run log only.
