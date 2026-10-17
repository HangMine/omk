# 세션 로그: tmux 사이드바 구현과 의존성/타입 오류 조사

- 기록 시각: 2026-10-17 03:41 KST
- 작업 저장소: OMK monorepo
- 당시 상태: tmux 사이드바 구현과 한정 검증 완료. 아래는 의존성/타입 오류 수정 전 조사 기록이다.
- 후속 결과: [의존성 및 타입 오류 후속 수정](2026-10-17-dependency-type-repair.md). 로컬 전체 검사는 통과했으며, AdaptOrch 타입 컴파일러 검증의 환경 차단은 별도로 남았다.
- 작업 방식: 루트 에이전트가 직접 조사, 수정, 테스트했다. 다른 세션의 변경은 보존했고 커밋, 푸시, 빌드, 의존성 설치는 하지 않았다.

## 이번 세션에서 한 일

### 1. 요청과 실행 환경 확인

처음에는 `Ctrl+Q` 종료 요청의 대상을 확인했다. 사용자는 사라진 사이드바를 tmux로 표시해 달라는 의도로 범위를 구체화했다. 최종 동작은 **OMK나 tmux 전체 종료가 아니라 오른쪽 사이드바 pane만 열기/닫기**로 정했다.

- 조사 당시 사용자 OMK는 tmux 밖에서 실행 중이었다.
- tmux 3.4가 설치되어 있었고 기본 서버에는 활성 세션이 없었다.
- 터미널은 133열, 66행으로 관측했다.
- Atelier 사용자 설정은 시작 시 사이드바 표시를 요청했고, 내장 `pinStatusSidebar`는 `false`였다.
- 전역 Atelier 확장 링크는 이 checkout의 확장을 가리켰다. 소스 수정만으로 이미 실행 중인 확장이 바뀌지는 않는다.

### 2. tmux 사이드바 구현

기존 Atelier 상태, TODO, 사용량 데이터와 렌더러를 재사용하고 표시 경로만 분리했다.

- tmux 안에서 시작하면 오른쪽 empty pane을 만들고 `display-message -I`의 stdin으로 프레임을 보낸다.
- `Ctrl+Q`와 `/atelier sidebar`는 같은 컨트롤러를 제어한다.
- tmux 밖에서는 기존 native 사이드바를 유지한다.
- 기본 폭은 44열이며, 처음 열 때 본문 최소 64열과 구분선을 포함해 OMK pane에 93열이 필요하다.
- tmux의 pane 크기 변경에 맞춰 다시 그린다. 이 모드에서는 native 자동 접기와 `Ctrl+Shift+R` 대신 tmux 크기 조절을 사용한다.
- 인스턴스별 소유자 표식을 확인해 다른 pane을 쓰거나 제거하지 않도록 했다.
- `/atelier disable`, `/reload`, 정상 종료 시 소유 pane과 출력 연결을 정리한다. 전역 tmux 키맵은 변경하지 않았다.
- 명시적 실행 스크립트 `scripts/omk-tmux.sh`를 추가했다. 이미 tmux 안이면 중첩하지 않는다.

주요 구현 경로:

- `.omk/extensions/atelier/src/tmux-sidebar.ts`
- `.omk/extensions/atelier/index.ts`
- `.omk/extensions/atelier/vendor/extensions/index.ts`
- `scripts/omk-tmux.sh`

문서와 검증 경로:

- `.omk/extensions/atelier/README.md`
- `packages/coding-agent/docs/atelier.md`
- `.omk/extensions/atelier/test/integration.test.ts`
- `.omk/extensions/atelier/test/tmux-launcher.test.ts`
- `.omk/extensions/atelier/UPSTREAM.json`

### 3. 호스트 버전 차이로 인한 초기화 실패 수정

checkout 호스트에는 Atelier가 가정한 `CONFIG_DIR_NAME`, `isProjectTrusted`, `getSubscriptionUsage` API가 모두 존재하지 않았다. 기존 native 로더 테스트도 undefined 경로 인자 오류로 초기화에 실패했다.

- 프로젝트 설정 경로를 OMK의 `.omk` 디렉터리로 명시했다.
- 신뢰 API가 없는 호스트는 신뢰를 추정하지 않고 프로젝트 설정과 작업공간 검사를 건너뛰도록 했다.
- quota API를 선택적 계약으로 취급하고, 없는 사용량은 unavailable로 표시한다.
- 신뢰 확인과 사용량 호환 처리는 `src/compat.ts`, `src/subscription-usage.ts`, `vendor/src/state.ts` 및 관련 테스트에 반영했다.
- 변경한 vendored 파일의 로컬 해시만 갱신했고 upstream 해시는 보존했다.

이 실패는 checkout 테스트에서 직접 재현했다. 사용자 화면에서 사이드바가 사라진 유일한 원인이라고 단정할 증거는 없다.

### 4. 저장소 전체 실패 후속 조사

사용자가 의존성/타입 오류 수정도 요청했다. 다음을 다시 실행해 동일한 실패를 확인했고 선언과 실제 설치 상태를 읽었다. 후속 수정 전에 세션 로그 작성 요청을 받아 현재 상태를 기록한다.

#### 의존성 검사: 2건 재현

`npm run check:dep-tree`는 다음을 invalid로 보고한다.

- `open-multi-agent-kit@1.3.0`
- `vitest@4.1.11`

중요한 정정: 앞선 임시 journal에는 첫 문제를 shadow copy로 표현했지만, 후속 `ls -ld` 확인 결과 `node_modules/open-multi-agent-kit`는 `../packages/coding-agent`를 가리키는 정상 형태의 심볼릭 링크다. **현재 증거로 물리적 중복 설치를 원인으로 단정하면 안 된다.** 검사기의 일반 오류 문구와 이번 설치의 구체적 원인을 구분한다.

확인한 선언 불일치:

| 항목 | 관측값 |
| --- | --- |
| 루트 `package.json` 버전 | `1.4.0` |
| `packages/coding-agent/package.json` 버전 | `1.3.0` |
| 다른 조사 대상 워크스페이스 버전 | `1.4.0` |
| `packages/book-to-skill/package.json`의 OMK 개발 의존성 | `^1.4.0` |
| 루트와 다른 워크스페이스의 Vitest 선언 | `4.1.11` |
| coding-agent의 Vitest 선언 | `3.2.6` |
| 실제 루트 Vitest 설치 | `4.1.11` |

따라서 워크스페이스 버전/테스트 도구 선언 불일치가 가장 강한 조사 결과다. 어떤 변경 흐름에서 불일치가 생겼는지는 아직 확인하지 않았다. `npm explain open-multi-agent-kit vitest --json` 결과를 보존했다. 재설치나 버전 수정은 아직 하지 않았다.

#### 루트 타입 검사: 7건 재현

`./node_modules/.bin/tsgo --noEmit`은 수정하지 않은 다음 파일에서 7건을 보고했다.

`packages/coding-agent/test/regression/package-install-isolation.test.ts`

- 34, 76행: `mockImplementation`이 `never` 타입에 없다는 오류.
- 110, 126행: `mockRejectedValue`가 `never` 타입에 없다는 오류.
- 48, 96, 97행: mock 호출 인자의 암시적 `any` 오류.

테스트는 private 메서드 spy를 만들 때 `vi.spyOn(manager as never, ...)`를 사용한다. private 메서드의 실제 시그니처는 `package-manager.ts`에서 확인했다. `as never`가 Vitest의 spy 타입 추론을 잃게 만드는 패턴이 우선 수정 후보이며, 아직 안전한 대체 방식으로 변경하거나 재검증하지 않았다.

## 검증 결과

| 검사 | 실제 결과 |
| --- | --- |
| tmux 기능 RED | 기존 native 컨트롤러가 44열 gutter를 예약해 `96` 대 `140` 기대값으로 실패 |
| `npm --prefix .omk/extensions/atelier test` | 종료 0, 56개 통과, 기존 native notification 테스트 1개 skip |
| `npm --prefix .omk/extensions/atelier run typecheck` | 종료 0 |
| 변경 TS 파일 7개 primary LSP | 오류 0 |
| 변경 파일 범위 Biome 검사 | 종료 0 |
| `npm --prefix .omk/extensions/atelier run check:vendor` | 종료 0, 고정 파일 31개 검증 |
| `bash -n scripts/omk-tmux.sh` | 종료 0 |
| `npm run check:module-size` | 종료 0 |
| `npm run check:doc-links` | 종료 0 |
| `npm run check:private-home` | 종료 0 |
| `npm run check` | 종료 1, dependency-tree 단계에서 중단. 뒤의 전체 검사 통과를 의미하지 않음 |
| `npm run check:dep-tree` 재현 | 종료 1, invalid 2건 |
| 루트 `tsgo --noEmit` 재현 | 종료 2, 위 회귀 테스트 파일 오류 7건 |
| 마지막 `lens_diagnostics(mode=all)` | 세션에서 검사된 파일의 오류 0, advisory 경고 9개. 루트 타입 검사 통과를 대신하지 않음 |

통합 테스트는 실제 tmux에서 live TODO/quota 갱신, `Ctrl+Q` 핸들러, 폭 변경, 80열에서 열기 거절, 재로딩, 소유자 표식 변경 시 보존, 다른 window의 pane 보존을 확인했다.

설치된 OMK 1.4.1에서도 자격증명이 없는 격리 환경으로 직접 확인했다.

1. 실제 오른쪽 pane 생성과 기존 렌더러 표시.
2. 초기 로그인 모달은 Escape로 건너뜀.
3. 실제 `C-q` 입력으로 사이드바만 닫기와 다시 열기.
4. `/reload` 시 pane 교체와 중복 pane 없음.
5. `/quit` 시 출력 연결과 사이드바 정리.

모델 프롬프트와 인증 정보는 제출하지 않았다. QA tmux 서버, 출력 프로세스와 임시 외부 디렉터리는 정리했다. 사용자 프로세스는 중단하거나 tmux로 이전하지 않았다.

## 주요 산출물과 근거

이번 세션에서 `outputs/`, `experiments/`, `papers/`에 작성한 산출물은 없다. `notes/`의 이 파일이 정식 세션 로그다. 다음 구현과 임시 근거 파일을 함께 참고한다.

| 경로 | 내용 |
| --- | --- |
| `notes/2026-10-17-tmux-sidebar-dependency-session.md` | 세션 요약과 후속 인수인계 |
| `.omk/extensions/atelier/src/tmux-sidebar.ts` | tmux 표시 컨트롤러 |
| `scripts/omk-tmux.sh` | 명시적 실행/재개 스크립트 |
| `packages/coding-agent/docs/atelier.md` | 사용법과 호스트 제약 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/journal.md` | 구현 당시의 임시 관측 기록. shadow-copy 진단은 위 정정 우선 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/npm-check.log` | 전체 검사 실패의 원본 출력 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/installed-sidebar.txt` | 자격증명 없는 설치 런타임의 pane 텍스트 캡처 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/runtime-qa.mjs` | 설치 런타임 QA 스크립트 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/dependency-explain.json` | npm이 해석한 의존성 출처 |
| `.omk/tmp/tmux-sidebar-Vt7ogK/backups/` | 이번 수정 전 관련 파일 백업 |

`.omk/tmp/`는 로컬 임시 근거이며 fresh clone이나 배포 산출물에 존재한다고 가정하면 안 된다. QA 스크립트가 사용한 외부 임시 작업 디렉터리는 제거했으므로 재실행하려면 그 디렉터리를 먼저 재생성해야 한다.

## 남은 질문과 위험

- 루트와 coding-agent의 버전 불일치는 어떤 작업의 결과인가? 다른 세션의 릴리스 변경을 확인하지 않고 일괄 버전 올리기를 실행하면 안 된다.
- lockfile, 워크스페이스 manifest, 설치 트리를 어떤 최소 변경으로 맞출지 결정해야 한다. 아직 설치 트리를 다시 쓰지 않았다.
- private 메서드 spy를 타입 안전한 명시 계약으로 대체하면서 기존 실패 격리 테스트의 의미를 유지해야 한다. `any`, `@ts-ignore`, 검사 완화로 숨기면 안 된다.
- 전체 검사는 의존성 단계에서 중단됐으므로 이후 gate에 추가 실패가 있을 수 있다.
- 여러 세션이 checkout을 공유하며 조사 중에도 관련 없는 변경을 관측했다. 최신 diff를 확인한 뒤 정확한 파일/hunk만 수정해야 한다.
- tmux의 정상 종료 경로는 검증했지만 강제 SIGKILL 뒤 orphan pane 처리까지 검증하지는 않았다.
- `Ctrl+Q`는 OMK 입력 pane에서 동작한다. 별도 tmux pane에 포커스한 상태의 전역 토글은 구현하지 않았다.
- tmux 밖의 사용자 현재 세션은 자동 이전되지 않았다. 종료 후 실행 스크립트의 `--resume <session-id>`로 이어야 한다.

## 구체적인 다음 단계

1. 루트, coding-agent 및 의존하는 워크스페이스의 manifest와 lockfile diff를 다시 확인해 현재 의도된 버전을 확정한다.
2. coding-agent의 Vitest 선언을 루트 도구 체인과 일치시키고, OMK 버전/내부 의존성 불일치도 확인된 범위에서 바로잡는다. 기존 변경을 백업하고 lockfile 변경을 검토한다.
3. 필요한 경우 저장소 지침대로 lifecycle scripts를 실행하지 않는 설치로 로컬 트리를 재동기화한다. 새 의존성이나 검사 예외는 추가하지 않는다.
4. `package-install-isolation.test.ts`의 `as never` spy를 실제 private 메서드 시그니처에 맞는 테스트 계약으로 바꾸고, mock 인자가 추론되도록 한다.
5. `packages/coding-agent`에서 아래의 한정 테스트와 루트 타입/의존성 검사를 실행한다.

   ```bash
   node ../../node_modules/vitest/dist/cli.js --run test/regression/package-install-isolation.test.ts
   ```

   ```bash
   npm run check:dep-tree
   ./node_modules/.bin/tsgo --noEmit
   npm run check
   ```

6. 전체 검사에서 추가 실패가 발견되면 기존 실패와 새 실패를 구분해 원인을 고친다. baseline이나 보호 설정을 완화하지 않는다.
7. 최종 diff와 세션 진단을 직접 검토하고 통과한 검사, 남은 제약을 보고한다. 별도 승인 없이 커밋/푸시하지 않는다.

## 출처와 외부 주장 범위

판단 근거는 로컬 소스, 설치 manifest, tmux 3.4 로컬 매뉴얼과 직접 실행한 검사다. 이번 세션에서 새로운 웹 검색이나 논문 조사는 하지 않았다. 외부 최신 성능이나 보안 우위를 주장하지 않는다.

Atelier의 출처는 로컬 `UPSTREAM.json`에 기록된 다음 고정 버전이다.

- upstream 저장소: https://github.com/michaelmjhhhh/pi-atelier
- 고정 커밋: https://github.com/michaelmjhhhh/pi-atelier/commit/776c1e3701d7fced2115cdef27a58ca9f0f0bf07

위 URL은 provenance 참조이며 이번 세션에 원격 내용을 다시 가져와 검증했다는 뜻은 아니다.
