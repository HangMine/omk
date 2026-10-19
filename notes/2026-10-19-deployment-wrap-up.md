# OMK 1.5.2 이후 배포 마무리 점검

- 날짜: 2026-10-19 KST
- 기준 HEAD: `main` / `7e60de4d4a` (`Release v1.5.3` `e6396d1ae8` + next-cycle changelog)
- 상태: `v1.5.3` **배포 완료**. tag, GitHub Release, npm 7개 패키지, 바이너리 6종 모두 확인.
  Harness2는 1.5.3 미포함 판정.

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

## 1.5.3 배포 결과 (2026-10-19)

### 릴리스 커밋

| 항목 | 값 |
| --- | --- |
| 릴리스 커밋 | `e6396d1ae8` (`Release v1.5.3`) |
| 후속 커밋 | `07dffb132f`, `7e60de4d4a` (`Add [Unreleased] section for next cycle`) |
| tag | `v1.5.3` (push 완료) |
| 기준 버전 | 7개 workspace 모두 `1.5.3` |

### CI/CD

| 워크플로 | 결과 |
| --- | --- |
| CI `39220521113` (main, `7e60de4d`) | success |
| Build Binaries `39220501985` (`v1.5.3`) | success: build, attest, publish-npm, release |
| GitHub Release | <https://github.com/dmae97/omk/releases/tag/v1.5.3> (draft 아님) |

### npm 레지스트리 (7/7 확인)

`open-multi-agent-kit`, `omk-ai`, `omk-agent-core`, `omk-tui`, `omk-protocol`,
`omk-adaptorch-wpl`, `omk-book-to-skill` 모두 `latest = 1.5.3`, 버전별 tarball HTTP 200.

9.0 MB인 `open-multi-agent-kit`만 레지스트리 전파가 약 9분 늦었다. publish 잡은 이미
성공했고(`+ open-multi-agent-kit@1.5.3`), tarball이 404에서 200으로 바뀐 뒤 설치 검증을
진행했다. 이 지연은 배포 실패가 아니지만, 직후 `npm view`로 판정하면 오탐이 난다.

### 설치 및 바이너리 smoke

| 검증 | 결과 |
| --- | --- |
| 격리 디렉터리 `npm install open-multi-agent-kit@1.5.3` | 126 packages, 종료 0 |
| 설치 패키지 `package.json` version | `1.5.3` |
| `env -u OMK_PACKAGE_DIR ./node_modules/.bin/omk --version` | `1.5.3` |
| 동일 실행에 stale `OMK_PACKAGE_DIR` 유지 | `1.4.3` (변수 영향 재확인) |
| GitHub Release `SHA256SUMS`로 `omk-linux-x64.tar.gz` 검증 | `OK` |
| 압축 해제 바이너리 `--version` | `1.5.3` |

### 릴리스 중 발견해 고친 결함

1. **journal torn tail 오분류 (제품 코드).** `readRunJournal`이 writer append 중 잘린
   마지막 줄을 `integrity`로 보고했다. `readJournalBytes`의 재시도는 size/ctime 변경만
   감지하므로, open 전에 쓰고 read 후에 검사하는 창을 놓친다. 이제 잘린 tail은 bounded
   retry로 다시 읽고, 재시도가 소진되면 `journal_truncated`, 중간 파일 손상은 그대로
   `integrity`다. `test/verified-run-journal.test.ts`의 torn-tail 계약은 유지된다.
2. **릴리스 스크립트의 changelog 전제.** 5개 패키지의 `[Unreleased]`가 1.5.2 아래에 있어
   `node scripts/release.mjs patch`가 첫 섹션을 1.5.3으로 바꾸며 순서가 깨졌다. 7개
   changelog의 `[Unreleased]`를 최상단으로 올린 뒤 릴리스했다.

### 부하 의존 테스트 (fixture만 수정, 단언 유지)

| 파일 | 변경 | 검증하는 의미 |
| --- | --- | --- |
| `compaction-deterministic-emergency.test.ts` | retry `baseDelayMs: 1` | transient 503을 deterministic trim으로 강등하지 않음 |
| `suite/agent-session-compaction.test.ts` | retry `baseDelayMs: 1` | declined handler 이름이 오류에 남음 |
| `verified-run.test.ts` | `workMs/verifyMs` 30초, deadline 시계를 예산에서 파생 | base 불변, candidate 고정, deadline 재확인 |
| `verified-run-authority-restart.test.ts` | grant `ttl: 60_000` | restart quarantine. 만료는 `authority-store.test.ts`가 `ttl: 50`으로 고정 |
| `memory-factorial.ts` | 시계 대기 상한 30초 | store의 실시간 가드와 future-dated 기억 거부는 그대로 |
| `verified-run-journal-read-retry.test.ts` | tail을 단일 `pwrite`로 기록 | 두 유효 상태만 생성, reader 재시도가 라이브 writer를 견딤 |

타임아웃/만료 동작 자체를 검증하는 테스트는 약화하지 않았다. `workMs: 100` deadline 테스트,
`ttl: 50` 만료 테스트, `journal_truncated` torn-tail 테스트가 그대로 통과한다.

### 최종 검증

| 명령 | 결과 |
| --- | --- |
| `./test.sh` (부하 load 26, 2회 연속) | 종료 0. coding-agent 771 파일, 9092+ 테스트 통과 |
| `npm run check` | 종료 0 (Biome, 16개 가드, tsgo, browser smoke) |
| `npm run build` | 종료 0, 7 workspace |
| AdaptOrch `CommandVerifier` 5개 묶음 | 5/5 PASS, pass_rate 1.0 (17, 27, 23, 51, 43 테스트) |
| CI (GitHub Actions) | success |

### 남은 위험

- **호스트 부하 민감도:** 이 호스트는 다른 프로젝트 테스트가 상시 돌아 load average가
  14~41로 변한다. fixture 예산을 늘려 실패는 사라졌지만, 아주 극단적인 부하에서는
  30초 Vitest 타임아웃에 다시 닿을 수 있다. CI(ubuntu-22.04)는 통과했다.
- **레지스트리 전파 지연:** 큰 패키지는 publish 성공 후에도 수 분간 404일 수 있다.
  배포 판정은 tarball 200과 설치 smoke로 해야 한다.
- **stale `OMK_PACKAGE_DIR`:** 이 셸의 값이 1.4.3 설치본을 가리킨다. 새 버전을 실행할
  때는 unset하거나 새 경로로 갱신해야 한다. 설치 검증에서 두 동작을 모두 확인했다.
- **실공급자 미호출:** 유료 모델, 실제 계정, 장시간 이미지 디코더 RSS는 이번에도 측정하지
  않았다. in-flight 공유는 디코드 횟수로만 검증했다.
- **플랫폼:** 로컬은 Linux만 실행했다. macOS/Windows/ARM은 CI 빌드와 attest까지만 확인했고
  실제 실행 smoke는 하지 않았다.

## 독립 재검증 (2026-10-19 18:40 KST)

릴리스 후 별도 세션에서 `./test.sh`를 1회 실행했다. 실행 전 load average는 3.70이었고,
24코어 호스트에서 이 실행 자체의 Vitest 워커 때문에 실행 중 18까지 올라갔다. 같은 시각
다른 프로젝트(`/tmp/alma-codex`)의 `node --test`가 돌고 있었지만 OMK Vitest 프로세스는
없었다.

| 항목 | 값 |
| 명령 | `./test.sh` |
| exit code | 1 |
| 테스트 | 9153 중 9092 통과, 1 실패, 60 skipped |
| 테스트 파일 | 781 중 770 통과, 1 실패, 10 skipped |
| 실패 파일 | `test/verified-run-journal-read-retry.test.ts` |
| 실패 테스트 | "explain's journal read survives a writer appending mid-read" |
| 단언 | `expected [ 'integrity' ] to deeply equal []` |
| tui `node:test` | 2건은 `# known defect` todo. 이번 변경과 무관 |

### 실패 원인 (코드 경로)

`readRunJournal`은 마지막 바이트가 개행이 아니면 최대 `JOURNAL_READ_RETRIES`(3)번 다시
읽고 그 뒤 `journal_truncated`를 던진다. 그런데 그 안에서 호출하는 `readJournalBytes`가
`VerifiedRunConcurrentChangeError`를 별도로 3번 재시도하고, 소진되면 그 예외를 그대로
던진다. 이 클래스는 `super("integrity")`이므로 최종 code가 `integrity`가 된다. 즉
size/ctime 경쟁이 4회 연속 발생하면 `journal_truncated`가 아니라 `integrity`가 표면화된다.

단독 실행은 3회 연속 6/6 통과했고, 13,000회 이상 읽기와 인위적 load 16에서도 재현되지
않았다. 전체 suite에서만 1회 발생했으므로 부하 의존 flake로 판정한다. 테스트 단언은
약화하지 않았다.

### RELEASE_NOTES 대조

- 기존 문구 "passed twice in a row ... load average about 26"는 이번 독립 실행으로
  재현되지 않았다. 과장으로 판정하고 `.github/RELEASE_NOTES_v1.5.3.md`를 실측에 맞게
  수정했다.
- 기존 문구 "still reports `journal_truncated` when the retries are exhausted"는 실제
  코드 경로와 부분 불일치한다. inner retry 소진은 `integrity`로 나온다. 문구를 정정했다.
- GitHub Release 본문은 게시 시점 문구를 유지한다. 본문 동기화는 별도 승인 후 실행한다.

## 시작 지연 측정 (2026-10-19)

`--version`은 0.05~0.06초, RSS 약 51MB로 빠르다. 실제 세션 기동은 RPC 모드 기준으로
측정했다. `OMK_TIMING=1` 구간 계측과 `/usr/bin/time`을 함께 사용했다. interactive
`OMK_STARTUP_BENCHMARK=1`은 TTY 없이 300초 타임아웃되어 RPC 계측으로 대체했다.

| 조건 | wall | max RSS | `createAgentSessionRuntime` |
| 실제 HOME, `~/.omk/mcp.json` 사용 | 8.80 s | 250 MB | 7,472 ms |
| 깨끗한 HOME, MCP 설정 없음 | 2.01 s | 148 MB | 585 ms |

전체 구간 중 `createAgentSessionRuntime`이 7,599ms 중 7,472ms를 차지한다. MCP manager는
이미 `Promise.all`로 병렬 연결하므로, 남은 비용은 가장 느린 MCP 서버의 초기화와
`listTools`다. 20여 개 서버를 시작 시 모두 spawn하는 구조가 지연과 RSS의 주원인이다.

**이번 배포에서 런타임을 바꾸지 않았다.** 지연 서버 하나가 전체 기동을 지배하는 구조라
안전한 최소 수정이 아니며, lazy attach나 서버별 기동 예산은 도구 노출 시점과 첫 턴 동작을
바꾸므로 별도 스펙과 회귀 검증이 필요하다. 측정값만 기록하고 후속 작업으로 넘긴다.

## AdaptOrch MCP 상태 (2026-10-19)

| 항목 | 결과 |
| 도구 노출 | 이 세션에서 `adaptorch__*` 도구가 실제로 노출됨 |
| `adaptorch_usage` | 성공. tenant `tenant_9bffe861...`, plan `team`, 2026-10, 14/2500 사용 |
| `adaptorch_capabilities` | 성공. synthesis 4종, topology 6종, connector 40여 종. `verification_commands_enabled: false` |
| `adaptorch-prod` 경로 | `/home/dmae97/projects/adaptorch`는 존재하지 않음. `/home/dmae97/Project/adaptorch`로 수정하고 JSON 유효성 확인. 파일은 `_disabledMcpServers`에 있어 계속 비활성 |
| `_note`의 swe-2 pin | 로컬 `Project/adaptorch`에서 `adaptorch_mcp_swe2_pin` 심볼을 찾지 못함. 서버 측 제약인지 미검증 |

`~/.omk/agent/mcp.json`은 OMK의 MCP 탐색 경로(`~/.kimi/mcp.json`, `~/.omk/mcp.json`,
`<cwd>/.omk/mcp.json`)에 포함되지 않는다. 따라서 이 파일의 `adaptorch-prod` 항목은
현재 런타임에 로드되지 않는 휴면 설정이다. 삭제하지 않고 경로만 고쳤다.

swe-2 pin은 실제 `adaptorch_run` 호출로만 확인할 수 있다. 유료 provider 호출과 quota
1 unit을 쓰므로 승인 없이 실행하지 않았다.

## 남은 검증과 잔여 위험 (후속 TODO)

1. **journal retry 코드 매핑:** inner retry 소진을 `journal_truncated`로 정규화하거나
   재시도 예산을 outer와 합친다. 부하 의존 1건을 결정론적으로 만든다. 테스트 단언은 유지한다.
2. **전체 suite 초록 확보:** 부하 없는 상태에서 `./test.sh` 2회 연속 exit 0을 확인한다.
   현재 근거는 1회 exit 1이다.
3. **MCP 시작 지연:** lazy attach 또는 서버별 기동 예산을 별도 스펙으로 설계한다.
   측정 기준은 RPC 기동 wall 8.8초, RSS 250MB다.
4. **swe-2 pin 검증:** 저비용 `adaptorch_run` 1회로 model 거부 여부를 확인한다.
   유료 호출 승인이 필요하다.
5. **GitHub Release 본문 동기화:** 수정한 릴리스 노트 문구를 Release 본문에 반영한다.
   배포 작업이므로 별도 승인 후 실행한다.
6. **플랫폼 smoke:** macOS, Windows, ARM 실제 실행은 미검증이다. CI 빌드와 attest만 확인됐다.
7. **stale `OMK_PACKAGE_DIR`:** 이 셸의 값이 1.4.3 설치본을 가리킨다. 실행 전 unset 또는
   새 경로로 갱신해야 한다.
8. **Harness2 파일럿:** `notes/2026-10-19-harness2-assessment.md`의 최소 파일럿은 설계만
   완료됐다. 제품 코드 변경 없이 `research/`에서 OmkSubstrate materialize 스파이크부터
   시작한다.

## 배포 판정

- v1.5.3은 tag, GitHub Release, npm 7개 패키지 모두 게시된 상태다. 이번 작업은 게시된
  산출물을 바꾸지 않는다.
- 이번 커밋은 릴리스 노트와 배포 기록의 사실 정정만 포함한다. tag, npm publish,
  GitHub Release 본문 수정은 하지 않는다.
- 배포 준비 상태는 `PARTIAL`이다. 전체 suite 초록 2회와 journal flake 안정화가 끝나야
  다음 패치의 배포 근거가 완성된다.
