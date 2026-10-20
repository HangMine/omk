# Feature Specification: skill candidates from the `!omk` hub router

Status: DRAFT (PREREG not yet frozen; items marked TBD need Tech Lead sign-off)
Branch: `spec/092-hub-router-skills` · Base: origin/main `86e5044a7b`

## Problem

Spec 091 stage 2 attached local bm25 candidates from the full skill catalog. Its free gate failed:
gold skill missed in 39/100 EN sentences (gate was ≤1/100). Cause: candidates were any doc with bm25
score > 0, capped at 64, so the gold skill was often below the cap or scored 0. Stage 2 is closed (091 gate FAIL).

The user (인호) asked to attach only related skills, via the existing `!omk` hub groups
(`omk-frontend`, `omk-backend-data`, `omk-loop`, `omk-plan`, ...; fallback `omk-skills`):
the hub router picks one hub, and only that hub's member skills become candidates.

## Design

1. Router: reuse `resolveOmkHubRoute` in `packages/coding-agent/src/core/bang-skill-invocation.ts`
   unchanged (deterministic: exact first-token alias match; else score aliases +4 / keywords +2 per
   token hit, highest score wins, ties by table order; score 0 → `omk-skills`). No model call.
2. Hubs (12 + fallback, from `OMK_HUB_ROUTES`): omk-frontend, omk-backend-data, omk-loop, omk-plan,
   omk-engineering, omk-security, omk-devops-release, omk-research-docs, omk-design-media,
   omk-agent-ops, omk-product-ops, omk-workspace-ops; fallback omk-skills.
3. Membership: hub → member skills is taken from each hub skill's SKILL.md body (the skills it lists).
   The membership table is frozen as a file with its sha256 before measuring (see PREREG).
   Skills listed by no hub keep their place in the sample; their gold hub is `omk-skills`.
4. Candidate block: members of the routed hub rendered with the 091 `renderCandidates` format
   (`<skill_candidates>` / name, description, location). Routed to `omk-skills` → no candidate block
   (only the index skill, as today).
5. Flag: `OMK_HUB_SKILL_CANDIDATES=1`, default off. Off = byte-identical to main.

## Measurement (PREREG — all numbers fixed before any run)

Inputs (frozen):
- Catalog: `/workspace/omk-eval-091/catalog-v2.json` sha256 `ce30f5f6a617bcd24be4116eb3f1a06623d0c0a82570ab80c5bfc005228c448c` (217 selectable).
- EN set: `labels-en-v1.jsonl` sha256 `adadd76d7d543ded09cf8e93472966c36483886bf4b094b13242671a3e0361dd`
  (100 answerable + 10 no-answer). Reuse is allowed because the router was never tuned on it.
- Router: `bang-skill-invocation.ts` git blob `ab78cd6951cd43d6881094bfdf0a5947eaed4fd0`,
  file sha256 `ab11c8ccb1bcfebc1d3b2b0641a5520f4d725ffbf822d6672344233fb89e9b77` (at `86e5044a7b`).
  Word lists and hub list are frozen; never edited after results.
- Membership table: `specs/092-hub-router-skills/hub-membership.json` sha256 TBD (derived from hub SKILL.md bodies).
- Gold skill → gold hub table: built by Agent Researcher, who has not seen router output on the EN set.
  sha256 TBD. Harness Engineer must not run the router on the EN set before both shas are recorded here.

Scoring:
- Correct (answerable) = routed hub == gold hub (equivalently gold skill ∈ routed hub's members).
- Answerable sentence routed to `omk-skills` = miss unless its gold hub is `omk-skills`. Counted and reported separately.
- No-answer (10): routed to `omk-skills` or no hub = correct; any other hub = false attach.

Gates (hub level only):
- G1: hub-level miss ≤ 1/100.
- G2: max skills per hub ≤ 25 (proposed). Report actual per-hub counts.
- G3: max candidate block per hub ≤ 32k tokens (estimateTokens = chars/4). Report actual per-hub sizes.
- G4: no-answer false attach ≤ 2/10 (proposed, TBD-for-Tech-Lead).
- Report (not gated): exact-skill-level accuracy = gold skill ∈ candidates AND hub correct;
  count of answerable sentences routed to `omk-skills`; count of skills in no hub.

If any gate fails → hub stage closed. Next is the all-217 paid Jev arm, which needs its own spec
criteria before running (accuracy lower bound, no-answer false-attach upper bound, token/cost cap)
and 인호's 1:1 OK. No paid call is part of this spec.

## Pre-measure facts (catalog only, EN set not touched)

- All 217 skills rendered in one block ≈ 89,577 chars ≈ 22,394 tokens, so G3 cannot fail for any subset.
- 54/217 catalog entries have a broken description (`>-`, unparsed YAML folded scalar). This lowers
  block size and harms any description-based selection; fix in the catalog is out of scope, noted as risk.

## Known risks

- Hubs are coarse (12 roles over 217 skills); one sentence may fit two hubs while only one wins.
- `omk-skills` fallback absorbs any sentence with no alias/keyword token hit; the router uses exact tokens
  only (no stemming), so "components" ≠ "component".
- Same EN set reused from 091 (router never tuned on it; lists frozen).
- Hub SKILL.md membership may not exist yet for every hub (see blocker below); G2 may fail on large hubs.

## Blocker (open)

No hub SKILL.md (omk-frontend, omk-backend-data, ..., omk-skills) was found on the box or in catalog-v2;
only unrelated skills like `omk-frontend-ui-review` exist. Membership source must be located or authored
(then frozen) before PREREG can close.

## Rollback

Flag default off; remove the flag path. No change to router or main behaviour.
