# OMK 1.5.2 이후 배포 마무리 점검

- 날짜: 2026-10-19 KST
- 기준 HEAD: `main` / `79606b72a1` (부모 릴리스 커밋 `cf40e647e0`, `v1.5.2`)
- 상태: 코드 변경 `WIRED` + 범위 한정 `VERIFIED_LOCAL`/`VERIFIED_ADAPTORCH`. Harness2는 1.5.3 미포함 판정.
  커밋, 푸시, 태그, npm 배포는 수행하지 않았다.

## 이번 변경

### 1. 스킬 선택 phase 배선

`SkillSearchGate`가 `SkillSearchSession`을 만들 때 `phase`를 넘기지 않아, `metacon` 랭커와
`skill-select` run log의 `phase`/`phaseSource`가 항상 `task` 기본값이었다. 이미 존재하던
`todo-runtime-state.activeTodoKind()`를 게이트에서 전달하도록 연결했다.

- 진입점: `AgentSession` 생성자 → `PromptSkillFreeze.skillSearch.setup(...)`
- 소비 경로: `SkillSearchGate.candidates/search` → `SkillSearchSession.rank` → `rankSkills(..., { phase })`
  → `metacon` 계획 및 run log
- 변경: `src/core/skill-search-gate.ts`, `src/core/skill-search.ts`
- 회귀: `test/skill-search-gate-phase.test.ts` (active TODO `debug` → `phaseSource: "todo"`,
  TODO 없음 → `phase: "task"`, `phaseSource: "default"`)

### 2. 첨부 미리보기 in-flight 디코드 공유

현재 캐시는 완료된 결과만 저장했다. 같은 첨부를 동시에 그리는 두 미리보기는 각자
Photon 전체 해상도 이미지와 리사이즈 버퍼를 할당할 수 있었다. `WeakMap` 값을
`{ result, pending }`으로 바꾸고 진행 중 Promise를 공유해 첨부당 디코드를 하나로 제한했다.

- 진입점: TUI 첨부 스트립 렌더/리페인트 → `createAttachmentStrip`
- 소비 경로: `decodeToRgba` → `loadPhoton`/Photon decode → `renderTile`
- 변경: `src/modes/interactive/components/attachment-strip.ts`
- 회귀: `test/attachment-strip-preview.test.ts`에 동시 미리보기 2개가 `getBytes`를 1회만
  호출하고 둘 다 실제 RGBA를 렌더하는 케이스 추가

## 로컬 검증

| 명령 | 결과 |
| --- | --- |
| `vitest --run test/attachment-strip-preview.test.ts test/attachment-strip-width.test.ts test/skill-search-gate-phase.test.ts test/skill-search.test.ts test/skill-select-rankers.test.ts` | 종료 0, 5 파일 / 43 테스트 통과 |
| `npm run check` | 종료 0 (Biome, 가드, tsgo, browser smoke 포함) |
| `npx biome check --write` (변경 5파일) | 종료 0 |
| `git diff --check` | 종료 0 |
| `node scripts/sync-readme-releases.mjs --check` | 종료 0 (`[Unreleased]`를 최신 릴리스 위로 이동) |
| `npm run build` | 종료 0, 7개 workspace 빌드 |
| `env -u OMK_PACKAGE_DIR node packages/coding-agent/dist/cli.js --version` | 종료 0, `1.5.2` |
| 동일 빌드 CLI `--help` | 종료 0 |

## AdaptOrch 검증 (별도)

- 사용 인터페이스: `adaptorch.verification.CommandVerifier` (engine `8f992a3fdf88bc072333c039ff65310a05df932c`, version `0.1.2`).
- 실행 명령: 위 5개 테스트 파일을 `packages/coding-agent`에서 Vitest로 실행.
- 결과: 기본 sandbox 제한에서 Node가 시작 직후 `SIGABRT`(exit -6)로 종료됐다. 메모리 상한을 4 GiB,
  CPU 180초, 파일 64 MiB, 프로세스 64로 올려도 같은 지점(약 89 ms)에서 실패했다. 이는 테스트 실패가
  아니라 검증기 샌드박스와 이 Node 런타임의 호환 실패다. AdaptOrch 결과는 `BLOCKED`로 기록하며,
  로컬 Vitest 결과를 AdaptOrch 통과로 포장하지 않는다.

## 배포 마무리 재검증 (2026-10-19 오후)

전체 suite를 다시 돌린 결과 coding-agent Vitest 4파일/11테스트가 실패했다. 실패 파일은
`compaction-deterministic-emergency`, `memory-factorial`, `verified-run`,
`suite/agent-session-compaction`이며 모두 이번 diff가 건드리지 않은 파일이고, 변경 모듈을
import하지도 않는다. HEAD만 체크아웃한 별도 worktree(`/tmp/omk-baseline`)에서 같은 파일을
실행해 동일 실패를 재현했다. 따라서 **선행 실패**이며 이번 변경의 회귀가 아니다.
같은 시간대에 다른 세션이 같은 저장소에서 `npm test`를 병렬 실행해 load average가 44까지
올라간 점도 타임아웃 실패에 영향을 준다.

| 명령 | 결과 |
| `./test.sh` | 종료 1. 9153 테스트 중 9082 통과, 11 실패(위 4파일), 60 skipped. tui `node:test` 829/831 통과(2건은 기존 `todo` known defect) |
| `npm run check` | 종료 0 (Biome, 16개 가드, tsgo, browser smoke 포함) |
| `npm run build` | 종료 0, 7 workspace |
| `npx vitest --run` 5개 대상 파일 | 종료 0, 43 테스트 통과 |
| `env -u OMK_PACKAGE_DIR node packages/coding-agent/dist/cli.js --version` | `1.5.2` |
| `OMK_PACKAGE_DIR=<stale 1.4.3> ... --version` | `1.4.3` (변수 영향 재확인) |
| `OMK_ENGINE_ROOT=/home/dmae97/Project/omk ~/.omk/agent/bin/omk --version` | `1.5.2` |
| 기본 런처 `omk --version` | `1.4.3` (설치본 유지, 미교체) |
| `node scripts/local-release.mjs --skip-check --skip-test --out /tmp/omk-release-1.5.2 --force` | 종료 0. 7 tarball + linux-x64 Bun 바이너리 + 격리 npm/Bun 설치 생성 |
| 격리 npm 설치 CLI `--version` | `1.5.2` |
| 로컬 Bun 바이너리 `--version` | `1.5.2` |
| 격리 Bun 패키지 설치 CLI `--version` | `1.5.2` |
| `git diff --check` | 종료 0 |

### AdaptOrch 검증 (별도)

- 인터페이스: `adaptorch.verification.CommandVerifier`, 엔진 `/home/dmae97/Project/adaptorch`,
  revision `8f992a3fd`, version `0.1.2`.
- 첫 시도는 `SandboxLimits(max_processes=64)`에서 110 ms 만에 `SIGABRT`(exit -6)로 실패했다.
  스택은 `uv_thread_create` assertion이며, RLIMIT_NPROC가 Node 워커 스레드 생성을 막은 것이다.
  테스트 실패가 아니라 검증기 샌드박스 설정 문제다.
- `max_processes=None`으로 바꾼 재실행은 통과했다.

| AdaptOrch 명령 | 결과 |
| 5개 대상 Vitest 파일 | PASS, 종료 0, 4.3 s (43 테스트) |
| `env -u OMK_PACKAGE_DIR node packages/coding-agent/dist/cli.js --version` | PASS, 종료 0, stdout `1.5.2` |

전체 suite와 `npm run check`는 AdaptOrch로 실행하지 않았다. 위 두 명령만 AdaptOrch 통과이며,
나머지는 로컬 실행 결과다.

## CI 실패 원인 규명과 테스트 수정 (2026-10-19 14:30)

`gh run list`로 `main`의 최신 CI(`39198074708`, Harness2 문서 커밋)를 확인했고
`build-check-test`가 `Test` 단계에서 실패하고 있었다. 실패는 정확히 2건이며 둘 다 30초
타임아웃이었다.

- 원인: 1.5.1에서 기본 `retry.maxRetries`가 5로 바뀌었다. 두 테스트는 재시도를 명시하지
  않아 기본 백오프 2+4+8+16+32=62초를 기다렸고, Vitest `testTimeout: 30000`을 넘겼다.
  단언 실패가 아니라 시간 초과다. `-t`로 단독 실행하면 62.1초에 통과해 원인을 확인했다.
- 수정: 두 테스트에만 `settings: { retry: { enabled: true, maxRetries: 5, baseDelayMs: 1 } }`을
  넘겼다. 재시도 횟수, 재시도 경로, 단언은 그대로 두고 백오프만 줄였다.
  - `test/compaction-deterministic-emergency.test.ts` → "does not degrade a transient failure…"
  - `test/suite/agent-session-compaction.test.ts` → "names the declined handler…"
- 결과: 두 파일 51 테스트가 0.4 s / 3.4 s에 통과. 단독 반복 실행에서도 타임아웃이 사라졌다.

| 명령 | 결과 |
| `npx vitest --run test/compaction-deterministic-emergency.test.ts test/suite/agent-session-compaction.test.ts` | 종료 0, 2 파일 / 51 테스트 |
| `npx biome check` (수정 2파일) | 종료 0 |
| `npm run check` | 종료 0 |
| `./test.sh` (4차) | 종료 1. 9153 중 9092 통과, 1 실패(`verified-run.test.ts`), 60 skipped |

## 남은 실패 1건 (선행 flake)

`test/verified-run.test.ts`의 "keeps the verifier candidate read-only"가 4차 전체 실행에서
`inconclusive`를 반환했다. 같은 파일만 3회 반복하면 27/27 통과했고, 다음 실행에서는 다른
케이스("does not expose the host state root…")가 대신 실패했다. 실패 지점이 매번 달라지고
단독 실행에서는 재현되지 않으므로 이번 diff와 무관한 **부하 의존 flake**로 판정한다.
이 파일은 변경 모듈(`skill-search-gate`, `attachment-strip`)을 import하지 않는다.

## 미검증 및 잔여 위험 (TODO)

- **`verified-run.test.ts` flake:** 샌드박스 실행 타이밍에 의존한다. 단독 27/27 통과, 전체
  실행에서 0~1건 실패. 원인 규명(실행 시간 상한, sandbox group reap 경쟁)과 안정화는 별도
  작업이다. 이 항목이 남아 있는 한 `./test.sh`는 초록이 아니다.
- **전체 suite 부하 민감도:** 다른 세션이 같은 저장소에서 `npm test`를 병렬 실행하면
  `memory-factorial`(clock fixture), `verified-run-*`(프로세스/타임아웃), `goal-verification`
  같은 시간 의존 테스트가 연쇄 실패한다. 3차 실행에서 17파일, 2차에서 13파일이 실패했지만
  부하가 없을 때 같은 파일들이 통과했다. 릴리스 판정은 단독 실행 결과를 기준으로 해야 한다.
- **운영 반영 미실행:** `npm run build`와 빌드 CLI smoke는 통과했지만, 설치된 런처의 `dist` 교체와
  실행 중인 TUI 재시작은 하지 않았다. 기본 런처는 여전히 `1.4.3`을 출력한다. 개발 트리를
  쓰려면 `OMK_ENGINE_ROOT=/home/dmae97/Project/omk`로 실행하고, 운영 반영은
  `/home/dmae97/.omk/agent/engines/`에 새 엔진을 두고 `~/omk` 심링크를 바꾸는 절차가 필요하다.
- **stale `OMK_PACKAGE_DIR`:** 이 환경의 `OMK_PACKAGE_DIR=/home/dmae97/omk/packages/coding-agent`가
  설치본 `1.4.3`을 가리킨다. 그대로 두면 새 빌드 CLI도 `--version`에서 1.4.3을 출력한다. 새 배포를
  검증하거나 실행할 때는 이 변수를 unset하거나 1.5.2 설치 경로로 갱신해야 한다.
- **실공급자 미호출:** 유료 모델, 실제 계정, 실제 이미지 디코더의 장시간 RSS를 측정하지 않았다.
  in-flight 공유는 디코드 횟수로 검증했으며 힙/RSS 감소 수치는 아니다.
- **플랫폼:** Linux/WSL 로컬만 확인했다. macOS, Windows, ARM 바이너리 실행은 미검증이다.
- **TODO phase의 세션 범위:** `todo-runtime-state`는 프로세스 전역 싱글턴이다. 여러 세션이
  한 프로세스에서 `update_todo`를 쓰면 phase는 마지막 갱신을 반영한다. 이번 변경은 기존
  설계를 그대로 사용하며 세션별 격리는 하지 않았다.
- **in-flight 수명:** 디코드가 끝나지 않으면 해당 첨부의 Promise가 남는다. Photon 호출에는
  취소 API가 없고, 기존 동작과 동일하게 정착까지 소유한다.
- **하네스 그래프 상시 감사 차단:** 이 환경에서 `bash .omk/harness-graph/run.sh`는
  `graph_analyze.py`의 `ModuleNotFoundError: networkx`로 종료 1이다. 그래프 빌드 자체는
  성공했고 `skillEdgesDead: 15`, `skillEdgesInactive: 27`, `orphan-active: 206`을 보고했다.
  이는 추적 소스가 아닌 로컬 하네스 도구이며 이번 배포 범위에 포함하지 않았다.
- **미통합 로컬 브랜치:** `harness/068-temp-output-cleanup`(임시 출력 정리, flag off)과
  `harness/071-b-subagent-concurrency`(tier 동시성/busy/worktree)는 main에 병합되지 않았다.
  파일 집합과 기반이 오래되어 이번 마무리에서 통합하지 않았다.
- **릴리스 게이트:** 커밋, push, PR, 태그, GitHub Release, npm publish를 하지 않았다.
  배포 판정은 로컬 검증만으로 `VERIFIED_ADAPTORCH`가 아니며, 전체 suite, 운영 smoke가 추가로 필요하다.

## 다음 배포 체크리스트

1. `./test.sh`를 부하 없는 상태에서 다시 실행해 `verified-run.test.ts` flake가 0건인지 확인
2. `OMK_PACKAGE_DIR`를 새 설치 경로로 갱신하거나 unset한 뒤 `npm run build`와 새 프로세스 smoke
3. 새 프로세스에서 첨부 미리보기와 `OMK_SKILL_SELECT=metacon`+`update_todo` 조합 smoke
4. macOS/Windows/ARM 바이너리 smoke
5. `git diff --check`, staged diff 검토, CHANGELOG `[Unreleased]` 확인
6. `.github/RELEASE_NOTES_v1.5.3.md` 작성과 README 릴리스 포인터 갱신(현재 파일 없음)
7. 커밋, push, 태그, npm 배포는 별도 승인 후 실행
