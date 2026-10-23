# Spec 117: skill auto-selection and body load (doc PR 2), default off

Status: draft (spec only, no code). Base: omk `5d22c0f32c` (main after #253, 1.5.7).
Source: 인호's doc "OMK v1.5.5 다음 개선안" §4 (요구사항 A) and §10 row **PR 2**
("자동 선택·자동 본문 로드·worker 전달 | 별도 스킬 지시 없이 관련 본문을 제공, 무관한 질의 0개 허용, 전체 요청 예산 충족").
Doc PR 1 (manifest, cap 10, official paths) is already on main as spec 106 A1 (#209, #210). This spec **reuses** it.
0 new dependencies.

## 1. What main already has (`5d22c0f32c`)

| piece | what it does | ref |
|---|---|---|
| `OMK_SKILL_ADMISSION` (default off) | `SkillAdmissionLedger`, cap `SKILL_ADMISSION_CAP = 10`, session entry `skill_admission`, policy `106-a1-r1`, `digestMode: "body"` | `src/core/skill-admission-ledger.ts:11-14,37` |
| one admission function | `admitSkillBody(sessionManager, skillId, body, source)`; used by `expandSkillCommand` (explicit/steer/followUp), `gateSkillRead` (read), `admitWorkerSkills` (worker) | `src/core/skill-admission-session.ts:71,102,133,164`; `agent-session.ts:1266,2700-2717,2738,2761` |
| sources | `"explicit" \| "steer" \| "followUp" \| "read" \| "default" \| "worker"`; **`"default"` is declared but no caller uses it** | `skill-admission-ledger.ts:16` |
| provider/lane selector | `selectSkills()`, `MAX_SELECTED_SKILLS = 3`, strong 0.7 / weak 0.35 / margin 0.08 | `src/core/skill-selector.ts:14-23`, `harness-skills.ts:39`, `provider-harness-dispatch.ts:163` |
| ranker | `OMK_SKILL_SELECT=bm25\|metacon` (alias `OMK_SKILL_SEARCH`), `OMK_SKILL_SEARCH_SUGGEST` (workers 0); `skill_search` limit 5/max 8 | `src/core/skill-search-mode.ts:11-18,59`, `skill-select-rankers.ts:83` |
| prompt choice | first prompt in system prompt, later prompts as a `prompt-skills` custom message; run log `skill-select` | `src/core/prompt-skill-message.ts:24-26,229` |
| active names | `createActiveSkillState`/`addActiveSkills`: plain Set union, no cap (doc §3.2: 9+1+1 = 11 names) | `src/core/active-skill-state.ts` |

Gap (the PR 2 scope): every selector above emits **names, descriptions and `<location>`** only
(`skills-prompt.ts:39`). A body reaches the model only when the model itself calls `read`, or the user types
`/skill:`/`!skill`. Nothing loads a selected body automatically, and the selector picks never pass through
`admitSkillBody`.

## 2. Change (behind `OMK_SKILL_AUTO_LOAD`, default off; requires `OMK_SKILL_ADMISSION=1`)

- Flag read per session start from `process.env`; values `1/on/true` = on. `OMK_SKILL_ADMISSION=1` is required:
  `OMK_SKILL_AUTO_LOAD` alone does nothing and writes one stderr warning per process (no second ledger, no second cap).
- Candidates = the **existing** selector output for the prompt (provider harness `selectSkills()` picks, or
  `OMK_SKILL_SELECT` ranker hits when active). No new ranker, no new thresholds.
- Load rule: only candidates that pass the existing **strong** threshold (`SKILL_STRONG_THRESHOLD`) are
  loaded, at most `MAX_SELECTED_SKILLS = 3` per prompt. The ambiguous band (weak..strong) is never loaded; it is
  only counted in the observe log (§3). Zero is a valid result (doc: "무관한 질의 0개 허용").
- Every load calls `admitSkillBody(..., source: "auto")`. `"auto"` is a new member of `SkillAdmissionSource`
  (not `"default"`, so logs tell auto-load apart from a later `defaultActiveSkills` path); no policyRevision
  bump, records stay readable by #209/#210. Cap refused ⇒ name stays as a candidate line, no body, counts-only trace.
- Delivery: bodies go in the existing `prompt-skills` custom message after the user message (spec 050 R6 path),
  never into the system prompt after the first prompt, so the cached prefix is unchanged.
- Budget: a dedicated skill budget owned by the existing admission path (`skill-admission-session.ts`), checked
  before a body is admitted: final request tokens (instructions + tools + history + bodies) must stay under it.
  It may **read** `compaction-headroom.ts` values (trigger, `reserveTokens`) but never mutates compaction state.
  Over budget ⇒ drop the lowest-ranked optional body; never drop required instructions or tools.
- Worker: workers receive only parent-selected, admitted skills through the existing `admitWorkerSkills` /
  `--skill` hand-off (#210). Worker-side auto-load is off in this PR (forced off in worker env) and comes only
  after the A/B. Workers keep `OMK_SKILL_SEARCH_SUGGEST=0`.
- Same `(skillId, digest)` already admitted ⇒ no reload, no new slot (ledger dedupe).
- Out of scope: `defaultActiveSkills` body load (separate PR), worker auto-load (after A/B), `bash cat SKILL.md` bypass (spec 106 open gap), changing `defaultActiveSkills` (stays ≤64
  preferences), raising the cap.

## 3. Step 1: observe-only run log (no flag, lands first, separate small PR)

When `OMK_RUN_LOG_DIR` is set, append one line per user prompt to `skill-autoload.jsonl`. Counts and hashes only, **no skill text, names or paths**:

`{sessionId, parentSessionId, seq, candidates, strongCandidates, ambiguousCandidates, wouldLoad, wouldLoadStrong, alreadyAdmitted, admittedTotal,
capRefusedWouldBe, bodyBytesWouldLoad, bodyTokensWouldLoad, requestTokensBefore, wouldExceedBudget,
modelReadSkillWithin3Turns, candidateDigests:[sha256], candidatePathHashes:[sha256], flags:{autoLoad, admission}}`

- `wouldLoadStrong` is computed with the §2 rule (what auto-load would actually load). `wouldLoad` = `wouldLoadStrong`
  + ambiguous-band candidates; the ambiguous part is observation only and is never loaded. Both are computed, never applied, when the flag is off.
- `modelReadSkillWithin3Turns`: count of `wouldLoad` skills the model later read itself (digest match) within 3 turns, written as a follow-up line `{seq, kind:"followup", ...}`.
- `seq` uses the bounded per-session counter pattern from #255/#256 (LRU 1000 sessions).

## 4. Gate (before implementing §2)

Run the observe log on the A/B baseline (main, all flags off, `OMK_SKILL_SELECT` as in the current baseline), TB 4.0 66 tasks. Implement only when:

- G1: >= 3 tasks with `wouldLoad >= 1` where the model did **not** read that skill (`wouldLoadStrong >= 1` and `modelReadSkillWithin3Turns < wouldLoadStrong`), i.e. auto-load would add something.
- G2: in >= 80% of prompts with `strongCandidates = 0`, `wouldLoadStrong = 0` (zero-load path is real).
- G3: 0 prompts with `wouldExceedBudget = true` among G1 tasks, or the budget drop rule is tested first.

Count by task (lead + workers grouped via `parentSessionId`). Under 3 ⇒ parked as weak evidence, reported as such.
If no task has any skill candidate on TB 4.0, the spec is parked.

## 5. A/B plan (team rule)

- TB 4.0, 66 tasks x n >= 5 per arm. Control: `OMK_SKILL_ADMISSION=1`; treatment: `+ OMK_SKILL_AUTO_LOAD=1`. Base SHA = main at A/B time (record it).
- Pass: task-clustered 95% CI lower bound of pass-rate delta > -3 points, total tokens <= 1.10x control, wall time <= 1.25x control, cost <= 1.10x control.
- Cache guardrail: report cache-read tokens per arm with task-clustered 95% CI; a drop is not waived by a pass-rate gain.
- Hard bar: 0 sessions with admitted bodies > 10 (from `skill_admission` entries).
- Secondary (report only): bodies loaded per task, model `read` calls on SKILL.md per task.
- Paid runs need 인호's dollar cap; nothing runs before that.

## 6. Tests

- Off (`OMK_SKILL_AUTO_LOAD` unset): provider request bytes and session file identical to main (snapshot), with and without `OMK_SKILL_ADMISSION`.
- `OMK_SKILL_AUTO_LOAD=1` without `OMK_SKILL_ADMISSION`: exactly one warning per process (two sessions ⇒ one line), request and session file identical to off.
- AL1: strong candidate ⇒ body in `prompt-skills` message, `skill_admission` record with source `auto`; system prompt bytes unchanged after first prompt.
- AL2: unrelated prompt (no strong candidate) ⇒ 0 bodies, 0 records.
- AL2b: ambiguous-band-only candidate ⇒ 0 bodies, 0 records; observe log has `wouldLoad = 1`, `wouldLoadStrong = 0`.
- AL1b: auto records carry source `"auto"`, never `"default"`; `defaultActiveSkills` names are not loaded as bodies.
- AL3: 9 admitted + 2 strong candidates ⇒ exactly 1 loaded, 1 counts-only refusal (reuses SK2 ledger path).
- AL4: same skill selected on two prompts ⇒ one record, no re-send of the body.
- AL5: large bodies over the skill budget ⇒ lowest-ranked dropped, request under budget, tools/instructions intact (doc SK6).
- AL5b: compaction headroom state (trigger, rearm, hysteresis) identical before and after an auto-load budget check.
- AL6: resume + compaction keeps count; auto load does not reset it (SK5 with `auto` source).
- AL7: worker gets only parent-selected admitted paths via `--skill`; worker auto-load and suggest stay off even with the flag set in the parent env.
- Run log: written only with `OMK_RUN_LOG_DIR`; no field contains skill name, path or text (assert no string field > 64 chars except hashes; names of fixture skills never appear); counter bounded (1000 sessions).
- Existing: SK1–SK7 suites, `skill-selector`, `prompt-skill-message`, `skill-search-gate` tests unchanged and green.

## 7. Decisions (Tech Lead, 2026-10-23 KST)

1. Source label: new `"auto"` in `SkillAdmissionSource`; `"default"` is not reused, so logs distinguish origin.
2. Load rule: strong candidates only. The ambiguous band is counted only in the observe log `wouldLoad`.
3. `defaultActiveSkills` body load: out of scope, separate PR.
4. Budget: dedicated skill budget on the existing admission path; may read `compaction-headroom.ts`, never mutates its state.
5. `OMK_SKILL_ADMISSION=1` is required; `OMK_SKILL_AUTO_LOAD` alone does nothing and warns once.
6. Workers receive only parent-selected skills; worker auto-load only after the A/B.
