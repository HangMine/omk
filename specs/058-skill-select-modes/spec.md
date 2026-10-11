---
description: "OMK_SKILL_SELECT=bm25|metacon으로 스킬 후보를 고르는 방식을 고른다. 꺼짐이 기본이고, 꺼지면 main과 같다. 모두 로컬에서만 돈다"
---

# Feature Specification: 스킬 선택 2단계 - 선택 방식 고르기 (bm25 / metacon)

**Specification ID**: `058-skill-select-modes`
**Feature Branch**: `docs/058-skill-select-modes` (문서만, origin/main `b60d3c4`에서 분기)
**Created**: 2026-10-11
**Status**: Draft (구현 전. 범위 결정: 1.5.0은 `bm25|metacon`만 받는다. `wpl`은 Future, 아래 "범위 변경")
**Constitution**: [specs/constitution.md](../constitution.md)
**Input**: 인호 요청(1.5.0 하나로 묶어 낸다. 스킬 1,191개를 adaptorch wpl과 metacon으로 고르기). OMK가 맡는다.
**Depends on**: spec 050 구현 PR #121(R6)과 #122(`OMK_SKILL_SEARCH`, `skill_search`, BM25 인덱스), spec 042(`appendRunLog`), spec 049(`TodoKind`, `activeTodoKind()`. 선택 입력이고, 없으면 대체값을 쓴다).

## 범위 변경 (2026-10-11, OMK 결정)

처음 요청은 `bm25|wpl|metacon` 세 방식이었다. 코드를 읽어 보니 `omk-adaptorch-wpl`에는 스킬을 고르거나 순위를 매기는 함수가 없다(아래 "지금 코드가 하는 일"). 그래서 1.5.0에서는 `bm25`와 `metacon`만 받는다. `wpl`은 받지 않고, `metacon`의 별칭으로도 두지 않는다. `wpl` 방식은 먼저 `omk-adaptorch-wpl`에 로컬 순위 모듈이 있어야 하고, 그 모듈은 자기 spec과 근거가 필요하다(P2 규칙: 근거 없이 새 orchestration을 더하지 않는다). Future에 적는다.

## 지금 코드가 하는 일 (origin/main `b60d3c4`와 #121/#122, 경로는 `packages/coding-agent/src/` 기준)

- **#122(`OMK_SKILL_SEARCH`)**: 스킬이 24개를 넘고 `read` 도구가 있으면 system의 `<available_skills>` 목록을 고정 한 줄로 바꾸고, 고정 `skill_search` 도구를 하나 더한다. 순위는 `metacognition/retrieval.ts:31` `searchCorpus`(BM25)다. 작업 시작 때 후보 ≤3개를 `<skill_candidates>` 끝 메시지로 보낸다. 인덱스는 첫 사용 때 만들고 `<agentDir>/cache/skill-index-v1.json`에 캐시한다(`core/skill-search.ts`).
- **#121(R6)**: 첫 프롬프트의 스킬 선택을 system에 고정한다. 두 번째 프롬프트부터 다시 고른 스킬은 `<prompt_skills>` 끝 메시지로 보낸다(`core/prompt-skill-message.ts`). 가장 최근의 `<prompt_skills>`만 적용한다.
- **`metacognition/skills.ts:52` `planSkills(input: SkillPlanInput): SkillPlan`**(MIT, I/O 없음): 능력 커버리지로 스킬 집합을 고른다. 후보가 12개 이하면 정확 탐색(`runExactSearch`), 넘으면 greedy와 singleton 보정(`runGreedySearch`)이다(`metacognition/skill-search-space.ts`). 지금은 **제품 코드에서 부르는 곳이 없다**. 테스트(`test/metacognition-skills.test.ts`)만 있다.
  - 입력: `phase`(≤128자), `needs: {capability, weight(0~1e6), required}[]`(≤128), `catalog: SkillDescriptor[]`(**≤500**), `approvedHashes`(id→contentHash), `installedVersions`, `allowedPermissions`, `explicitSkills`(≤64), `tokenBudget`(≤1e7), `maxSkills`(≤64).
  - `SkillDescriptor`: `id`, `contentHash`, `capabilities`(≤128), `phases`(≤32), `tokenCost`, `dependencies`, `conflicts`, `permissions`, `explicitOnly`, `packages`.
  - 출력: `selected`(사전순), `tokenCost`, `covered`, `uncoveredRequired`, `blockedExplicit`, `rejected`(id→이유), `algorithm`(`exact-small|greedy-with-singleton`), `state`(`covered|capability-gap|explicit-blocked`).
  - 잘못된 입력에는 `ensure`가 예외를 던진다.
- **`packages/adaptorch-wpl`(`omk-adaptorch-wpl`, MIT)**: Work Packet Loop의 상태 기계(`state-machine.ts`의 `canTransition`, `applyTransition`, `isTerminalState`, `requiresHumanApproval`), 다음 전이 도우미(`loop.ts`의 `decideNextTransition`), Outcome Adjudicator, B2C 매핑, 영수증 서명, AdaptOrch 클라이언트를 담는다.
  - **이 패키지에는 스킬을 고르거나 순위를 매기는 함수가 없다**(`rg -i "skill|rank|select"`로 확인, `proof-projection.ts`의 무관한 문자열 하나뿐).
  - 기본 CLI에는 WPL 루프를 도는 코드가 없다(README "Integration": `loop.ts`는 end-to-end dispatcher가 아니다). 코딩 에이전트가 이 패키지를 import하는 곳은 `commands/adaptorch-doctor-cli.ts`와 opt-in 예시 확장 `examples/extensions/correctness-wall/`뿐이다.
  - `adaptorch-client.ts`, `adaptorch-api.ts`, `live-adaptorch-transport.ts`, `mcp-introspection-transport.ts`는 AdaptOrch 서비스(사유 제품)로 나가는 경로다. 058은 이것들을 쓰지 않는다.
- **049 `TodoKind`**: `plan | explore | edit | debug | verify`. `core/todo-state.ts`와 `todo-runtime-state.ts`의 `activeTodoKind()`로 읽는다. **origin/main에는 아직 없다.**

## 결정할 점 (OMK 제안)

- 선택 방식은 둘이다. 둘 다 #122의 고정 도구, 고정 system 줄, 끝 메시지 형식을 그대로 쓴다. 바뀌는 것은 `skill_search` 결과와 작업 시작 후보의 **순서와 구성**뿐이다. 그래서 캐시 안정성(050 AC 2)은 방식과 상관없다.
- 1.5.0의 기본값은 꺼짐이다. 어느 방식을 기본으로 할지는 Bench Analyst의 A/B 뒤에 정한다.

## Requirements

### R1 - 플래그와 동작 조건 (P0)

- `OMK_SKILL_SELECT=bm25|metacon`. 설정하지 않거나 빈 값이면 꺼짐이고, 요청은 main과 바이트 단위로 같다(AC 1).
- 대소문자를 가리지 않는다. 그 밖의 값(`wpl` 포함)은 꺼짐으로 본다. 프로세스당 한 번 stderr에 경고를 낸다(`OMK_SKILL_SELECT=<값>: 알 수 없는 값이라 꺼짐으로 둡니다. bm25 또는 metacon`). `OMK_RUN_LOG_DIR`가 있으면 `session` 레코드에 `invalidMode: true`를 남긴다(값 원문은 남기지 않는다). 경고 문구를 요청에 넣지 않으므로 요청은 꺼짐과 같다.
- `bm25`는 #122의 `OMK_SKILL_SEARCH=1`과 같다. 1.5.0에서는 `OMK_SKILL_SEARCH=1`을 `OMK_SKILL_SELECT=bm25`의 별칭으로 남긴다. 둘 다 있으면 `OMK_SKILL_SELECT`가 이긴다.
- 동작 조건은 050 R1과 같다. 시작 시점의 model-invocable 스킬이 24개를 넘고 `read` 도구가 있을 때만 켜진다. 그 밖에는 방식과 상관없이 비활성이고, 요청은 main과 같다.
- 방식은 세션 시작 때 한 번 정하고 세션 동안 바꾸지 않는다(도구 목록과 system이 고정이기 때문이다).

### R2 - 공통 순위 인터페이스 (P0)

- `core/skill-select-rankers.ts`(새 파일, 지연 로드)에 `rankSkills(mode, query, context) → { name, score }[]`를 둔다. `context`는 `{ phase?: string, explicit: string[], limit: number }`다.
- `skill_search` 도구와 작업 시작 후보(#122 `SkillSearchSession.search`, `suggest`)가 이 함수를 부른다. 결과 렌더(`name — description — location`, `<skill_candidates>`), 중복 제안 금지, 점수 하한은 #122 그대로다.
- `details`의 `candidates[{name, score, location}]`에 `mode`를 더한다. 이후 TUI 카드가 어떤 방식이 골랐는지 그릴 수 있게 하려는 것이다. TUI는 만들지 않는다.

### R3 - `bm25` (P0)

- #122 그대로다. `searchCorpus(query, corpus, limit)`, 문서는 `name + " " + description`, 작업 시작 질의는 불용어를 뺀 내용어다.

### R4 - `metacon` (P0)

`planSkills`는 catalog가 500개까지라 1,191개를 바로 넣을 수 없다. 그래서 BM25로 줄인 뒤 커버리지로 고른다.

1. **앞단 줄이기**: `searchCorpus`로 상위 `METACON_PREFILTER = 64`개를 뽑는다(점수 > 0). 없으면 빈 결과다.
2. **`SkillDescriptor` 만들기**(뽑힌 스킬마다, `loadSkills()` 결과만 쓴다):
   - `id` = 스킬 이름.
   - `contentHash` = `Skill.contentHash`(로더가 낸 sha256), 없으면 `sha256(name + "\n" + description)`.
   - `capabilities` = 이름과 설명의 내용어(`retrievalTokens`에서 길이 1과 불용어를 뺀 것, 중복 제거, 앞 128개).
   - `phases` = `["task", "plan", "explore", "edit", "debug", "verify"]`(스킬 frontmatter에 단계 정보가 없어서 모든 단계에 쓸 수 있다고 본다).
   - `tokenCost` = `ceil((compact 설명 길이 + 위치 길이) / 4)`. 후보 메시지에 실제로 싣는 크기다.
   - `dependencies`, `conflicts`, `permissions` = `[]`. `packages` = `{}`. `explicitOnly` = `disableModelInvocation`.
3. **`SkillPlanInput`**:
   - `phase` = 049 `activeTodoKind()`가 있으면 그 값, 없으면 `"task"`. 049가 main에 없는 동안은 늘 `"task"`다.
   - `needs` = 질의의 내용어(≤128). 각 `weight`는 앞단에서 쓴 코퍼스 기준 IDF(최소 1), `required`는 모두 `false`다. 그래서 `state`는 `covered`나 `explicit-blocked`만 나온다.
   - `approvedHashes` = 인덱스를 만들 때 읽은 `{이름: contentHash}`. 인덱스 이후 SKILL.md가 바뀌면 그 스킬은 `unapproved-or-changed-content`로 빠진다. 다음 인덱스 재빌드 때 다시 들어온다.
   - `installedVersions` = `{}`, `allowedPermissions` = `[]`.
   - `explicitSkills` = 이번 프롬프트의 `!skill`·`/skill:` 이름 중 앞단 결과에 든 것.
   - `maxSkills` = 요청한 `limit`(후보는 3, 도구는 1..8). `tokenBudget` = `limit × 160`.
4. **출력**: `selected`를 BM25 점수 순으로 다시 정렬해 돌려준다. 점수는 BM25 점수다(커버리지 값은 로그에만 남긴다). `selected`가 `limit`보다 적으면 남은 자리를 BM25 순위로 채운다(중복 없이).
5. **실패**: `planSkills`가 예외를 던지거나 50 ms를 넘기면 그 호출만 `bm25` 결과를 쓰고 `fallback: "metacon-error"` 또는 `"metacon-slow"`를 남긴다. 세션의 방식은 바꾸지 않는다.

기대 효과: BM25 상위 3개가 같은 단어에 몰린 비슷한 스킬로 채워지는 경우, 커버리지 선택은 질의의 다른 단어를 덮는 스킬을 섞는다. 이것이 bm25와 다른 점이고, A/B에서 볼 점이다.

### R5 - 캐시 안정성 (P0, 050 R6 유지)

- 050 R6을 그대로 둔다. 첫 프롬프트의 선택(harness, `!skill`, budget 질의)은 system에 고정하고, 이후 다시 고른 스킬은 `<prompt_skills>` 끝 메시지로 보낸다. 가장 최근의 `<prompt_skills>`만 적용한다.
- 방식은 고정 도구의 **결과**와 끝 메시지의 **내용**만 바꾼다. system 바이트, tools 바이트, 앞 메시지는 세션 동안 같다(050 AC 2를 방식마다 돈다, AC 3).

### R6 - worker (P0)

- worker는 `OMK_SKILL_SELECT`를 물려받는다. `OMK_SKILL_SEARCH_SUGGEST=0`이 붙으므로(#122) 자동 후보는 없고, `skill_search`를 부를 때만 순위를 매긴다.

### R7 - run log (P0, spec 042)

`OMK_RUN_LOG_DIR`가 있을 때만 `skill-select.jsonl`에 남긴다. **해시와 숫자만** 남기고, 질의, 스킬 이름, 경로 원문은 남기지 않는다(050 AC 7과 같은 방법으로 확인).

- 모든 `search`·`suggest` 레코드에 `mode`, `candidateCount`(순위를 매긴 후보 수), `top[{ nameHash, score }]`(상위 k개, `nameHash`는 sha256 앞 12자, `score`는 소수 셋째 자리), `latencyMs`를 더한다.
- `metacon`은 `prefilter`(앞단 결과 수), `algorithm`, `state`, `coveredNeeds`, `needs`, `rejected`(이유별 개수), `phase`, `phaseSource`(`todo|default`), `planMs`, `fallback?`를 더한다.
- `session` 레코드에 `mode`(`off|bm25|metacon`)와 `invalidMode?`를 더한다.

### R8 - 지연 로드 (P0)

- 꺼짐과 비활성에서는 `skill-select-rankers.ts`, `skill-search.ts`, `metacognition/skills.ts`를 하나도 로드하지 않는다. 어느 방식도 `omk-adaptorch-wpl`을 import하지 않는다.
- 켜진 세션에서도 첫 검색이나 첫 작업 시작 후보 때 로드한다. 시작 경로에 넣지 않는다.

## Acceptance

- **AC 1 (꺼짐 동일성)**: `OMK_SKILL_SELECT`를 설정하지 않은 `-p` 요청이 main과 바이트 단위로 같다. 050 AC 11의 6케이스(default, xai, budget, bang, xaibang, xaibudget)를 같은 mock 캡처로 돈다. 두 방식 각각을 스킬 24개 이하로 켠 경우(비활성)와 `OMK_SKILL_SELECT=wpl`(알 수 없는 값)도 같아야 한다. 측정은 `OMK_TRUST_PROJECT=0`, 위에 AGENTS.md·CLAUDE.md가 없는 cwd에서 하고 그 조건을 기록한다.
- **AC 2 (방식별 단위 테스트, 고정 fixture)**: `test/fixtures/skill-select/`의 고정 카탈로그(합성 40개, 이름·설명 고정)와 고정 질의 5개로:
  - `bm25`: 상위 k 이름과 점수가 기대값과 같다.
  - `metacon`: 같은 단어에 몰린 비슷한 스킬 3개가 있는 질의에서, BM25 상위 3개와 달리 질의의 다른 내용어를 덮는 스킬이 들어간다. 같은 입력은 같은 출력을 낸다. `planSkills` 예외와 50 ms 초과에서 bm25로 물러난다. 인덱스 이후 바뀐 SKILL.md는 `rejected`에 들어간다.
  - 알 수 없는 값(`wpl`, `foo`)은 꺼짐이고, 경고는 프로세스당 한 번이다.
- **AC 3 (캐시 안정성)**: 050 AC 2 테스트(task 2개, `skill_search`, `/reload`)를 방식마다 돈다. 모든 호출의 `systemHash`·`toolsHash`가 첫 호출과 같고 앞 메시지가 유지된다.
- **AC 4 (시작 시간과 RSS)**: 합성 1,191개에서 쌍 측정을 하고 `paired_verdict.py --block startup_ms=5 --block idle_rss_mib=5`로 판정한다. 비교는 (a) 꺼짐 대 main, (b) 방식마다 켬 대 꺼짐이다. 명확한 회귀(BLOCK)가 없어야 한다. 측정은 박스 순서에 따라 슬롯을 받아 하고, `OMK_TRUST_PROJECT=0`과 cwd 조건을 기록한다.
- **AC 5 (log에 원문 없음)**: 고유 문자열을 질의와 스킬 설명에 심고, 방식마다 `skill-select.jsonl` 전체에 그 문자열, 스킬 이름, 경로가 없음을 확인한다.
- **AC 6 (로컬 전용)**: 방식마다 테스트에서 `fetch`, `net.connect`, `child_process` 호출 수를 세어 0이어야 한다. 정적 검사로 `skill-select-rankers.ts`와 `skill-search.ts`가 `omk-adaptorch-wpl`과 `core/adaptorch-bridge.ts`를 import하지 않음을 확인한다.
- **AC 7 (A/B 계획, 자리만)**: 방식 간 TB/작업 A/B는 Bench Analyst가 설계하고 판정한다. 1.5.0에서 기본값은 꺼짐이고, 어느 방식도 기본으로 켜지 않는다. 결과에 따라 이후 릴리스에서 기본값을 정한다.

## Non-goals

- **Adaptorch-MCP 서버나 AdaptOrch API를 부르는 것.** AdaptOrch는 사유 제품이고 근빈의 승인이 필요하다. 058의 모든 방식은 로컬 순수 함수만 쓴다. `adaptorch-client.ts`, `adaptorch-api.ts`, live/MCP transport, `core/adaptorch-bridge.ts`는 쓰지 않는다.
- 1.5.0에서 어느 방식이든 기본으로 켜는 것.
- 학습형 선택, 임베딩, 모델 호출로 고르기.
- `wpl` 방식(1.5.0). `omk-adaptorch-wpl`에 스킬 순위 함수가 없어서다. 알 수 없는 값으로 다루고 `metacon`의 별칭으로도 두지 않는다. 아래 Future.
- WPL 루프를 기본 CLI에 연결하는 것, packet 상태 변화를 후보 트리거로 쓰는 것.
- 스킬 frontmatter에 capabilities·phases 같은 새 필드를 더하는 것.
- 실제 스킬 디렉터리 정리나 수정. 테스트와 측정은 복사본이나 합성 세트만 쓴다.
- TUI 카드 구현.
- Perf Engineer 소유 파일(`core/skills.ts`, `core/package-manager.ts`, `resource-loader.ts`의 스킬 경로 코드) 수정. `loadSkills()` 결과만 쓴다.

## Future

- **`wpl` 방식**: 먼저 `omk-adaptorch-wpl`에 로컬 순수 순위 모듈(I/O와 네트워크 없음)을 만들어야 한다. 그 모듈은 자기 spec과 근거(이 spec의 `bm25`·`metacon` 대비 A/B)가 필요하다(P2 규칙). 초안 때 검토한 안은 Work Packet 상태(`WorkPacketState`)를 단계로 바꿔 `metacon`의 `phase`에 넣는 것이었다. 기본 CLI에는 WPL 루프가 없어서 그 안은 `metacon`과 결과가 같았고, 그래서 1.5.0에서 뺐다.

## 정할 질문

1. `metacon`의 `METACON_PREFILTER`(64)와 `tokenBudget`(`limit × 160`)은 AC 2 fixture와 1,191개 측정으로 맞춘다. A/B 전에 바꿀 수 있다.
2. 049가 1.5.0에 들어가지 않으면 `phase`는 늘 `"task"`다. 이것으로 충분한지 Tech Lead가 정한다.

## Expected Files (구현 PR)

- `packages/coding-agent/src/core/skill-select-mode.ts` 또는 #122의 `skill-search-mode.ts` 확장: `OMK_SKILL_SELECT` 해석, 별칭, 활성 판정
- `packages/coding-agent/src/core/skill-select-rankers.ts`(새 파일, 지연 로드): `rankSkills`, `metacon` 어댑터(`SkillDescriptor`·`SkillPlanInput` 만들기)
- `packages/coding-agent/src/core/skill-search.ts`(#122): 순위를 `rankSkills`로 바꾸고 R7 필드 추가
- `packages/coding-agent/src/core/tools/skill-search-tool.ts`(#122): `details.mode`
- 테스트: `test/skill-select-rankers.test.ts`, `test/fixtures/skill-select/`, `test/suite/skill-search-session.test.ts`(방식별 반복), `test/skill-search-flag-off-cold-path.test.ts`(방식별 미로드)
- 문서: `docs/skills.md`, `docs/environment-variables.md`
