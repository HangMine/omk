# 의존성 및 타입 오류 후속 수정

- 날짜: 2026-10-17 KST
- 시작 및 최종 HEAD: `main` / `8baa7435ff87e33ff6495761b2fb29265fea9cd8`
- 이전 조사: [tmux 사이드바와 오류 조사 로그](2026-10-17-tmux-sidebar-dependency-session.md)
- 상태: 코드 수정과 프로젝트 로컬 검증은 통과. AdaptOrch 제한 환경에서의 타입 컴파일러 검증은 차단 상태다.

## 목표와 범위

이전에 남은 dependency-tree 오류 2건과 TypeScript 오류 7건을 해소하고 실제 전체 검사를 실행한다. 새 버전 발행, 기능 추가, 런타임 교체, 보호 설정 완화는 범위가 아니다. 작업 시작 시 기존 변경을 확인하고 관련 파일을 백업했다. 공유 checkout의 다른 변경은 보존했다.

## 구현과 소비 경로

### 의존성 선언

`packages/coding-agent/package.json`만 루트와 기존 lockfile에 맞췄다.

- 패키지 버전: `1.3.0`에서 기존 워크스페이스 기준 `1.4.0`으로 정렬.
- 내부 OMK 의존성 5개의 범위: `^1.4.0`.
- Vitest: 기존 루트 설치와 lockfile의 `4.1.11`에 일치.

실제 `node_modules/open-multi-agent-kit`는 정상 심볼릭 링크였다. 설치 손상이 아니라 manifest 불일치였고 재설치 없이 `npm run check:dep-tree`의 문제가 0건이 됐다. 루트 `package-lock.json`과 설치 트리는 수정하지 않았다.

### 테스트 타입

`packages/coding-agent/test/regression/package-install-isolation.test.ts`에서 private 메서드에 대한 `as never` spy를 제거했다.

- `MockInstance<typeof console.error>`로 경고 관측 타입을 명시했다.
- 프로세스 실행 함수의 실제 인자/반환 타입에 맞는 `Mock`을 테스트 소유 인스턴스에 주입했다.
- `Object.defineProperties`로 테스트의 `runCommand`/`runCommandSync` 경계만 대체한다.
- `manager.resolve()`의 실제 설치 실패 격리, 기존 설치 fallback과 경고 관측은 유지했다.
- mock 호출 인자의 불필요한 tuple/string-array cast도 제거했다.

생산 코드의 visibility를 바꾸거나 `any`, `@ts-ignore`, 테스트 비활성화로 오류를 숨기지 않았다.

### 추가로 드러난 메타데이터 불일치

전체 검사를 진행하자 coding-agent의 changelog 최신 구간과 README 참조가 이전 버전으로 남아 있었다.

- `packages/coding-agent/CHANGELOG.md`: 이미 루트 README에 있던 `1.4.0` 구간을 문서 링크 경로만 바꿔 복원했다. 기존 `Unreleased` 내용과 다른 세션의 변경은 유지했다.
- `packages/coding-agent/README.md`: 릴리스/설치 예시 참조를 `1.4.0`으로 맞췄다.
- `packages/coding-agent/npm-shrinkwrap.json`: 기존 생성기 `npm run shrinkwrap:coding-agent`로 동기화했다. 변경은 OMK 버전, 내부 의존성 범위와 tarball URL의 버전 정렬이다.

소비 경로는 `npm run check`의 의존성 검사, 보안 manifest 회귀, 릴리스/changelog 검사, README 생성본 일치 검사, shrinkwrap 검사와 루트 `tsgo --noEmit`이다. 설치된 사용자 TUI를 바꾸는 작업은 하지 않았다.

## 실제 검증

| 명령/검사 | 결과 |
| --- | --- |
| 수정 전 `npm run check:dep-tree` | 종료 1, invalid 2건 |
| 수정 전 루트 `tsgo --noEmit` | 종료 2, 오류 7건 |
| 수정 전 workspace Vitest 보안 테스트 | coding-agent `3.2.6` 선언으로 RED |
| 수정 후 `npm run check:dep-tree` | 종료 0, 문제 0건 |
| 수정 후 `./node_modules/.bin/tsgo --noEmit` | 종료 0 |
| `test/regression/package-install-isolation.test.ts`와 `test/package-manager.test.ts` | 종료 0, 125개 통과 |
| README/changelog/toolchain 보안 Node 테스트 3개 파일 | 종료 0, 13개 통과 |
| `npm run check` | 종료 0, 내부 Node 테스트 413개 통과, 실패 0 |
| primary TypeScript LSP | 재조회에서 clean 확인. 첫 timeout을 clean으로 세지 않음 |
| 범위 제한 `lens_diagnostics(mode=all)` | 진단된 수정 파일의 오류 없음 |
| 변경 파일 `git diff --check` | 종료 0 |
| manifest와 기존 lock entry 필드 비교 | 일치 |
| task-start lockfile과 최종 lockfile 비교 | 동일 |

패키지 관리자 테스트 중 존재하지 않는 npm/git 패키지에 대한 예상 오류가 출력됐지만 최종 125개 테스트는 모두 통과했다. 전체 Vitest/e2e suite나 빌드는 실행하지 않았다.

## AdaptOrch 실행과 한계

등록된 AdaptOrch MCP 도구는 현재 도구 목록에 없다. 로컬 엔진과 CLI/SDK를 확인했다.

- 엔진 revision: `980c96d22bf27905e8455df1aa059b669dceff54`.
- skill/source surface drift 검사: 통과.
- CLI `--help` 확인과 `adaptorch.verification.CommandVerifier`의 실제 소스를 읽었다.
- 로컬 SDK를 직접 호출했다. hosted 서비스, 모델 provider, 합성, 다중 에이전트 실행은 하지 않았다.
- 후보는 변경 파일과 lockfile의 SHA-256 목록이며 캐시를 끄고 지정한 명령을 실제 실행했다.
- 제한: 명령당 90초, CPU 60초, 주소 공간 4 GiB, 파일 10 MiB, 사용자 프로세스 128. 부모 환경 상속을 끄고 필요한 `GOMAXPROCS=4`만 설정했다.

| AdaptOrch CommandVerifier 명령 | 결과 |
| --- | --- |
| Python manifest/lock 계약 검사 | PASS, 종료 0 |
| 설치된 native TypeScript 컴파일러 `tsgo --noEmit` | 실패, 종료 2. Go가 OS 스레드를 만들지 못함: `errno=11`, `newosproc` |

SDK 원본 결과는 `passed=false`, `pass_rate=0.5`, `failure_category=command_failed`다. 실패 stderr와 당시 사용자 프로세스 207개 관측은 `max_processes=128`에 따른 환경 자원 차단을 지지한다. 제품 타입 오류가 재발한 것으로 해석하지 않으며, SDK 실패를 PASS로 재분류하지도 않는다. 제한을 완화하거나 자동 재시도하지 않았다. **프로젝트 로컬 검사 통과와 AdaptOrch 검증 전체 통과는 서로 다른 결과다.**

## 남은 위험과 다음 단계

1. AdaptOrch에서 타입 컴파일러까지 통과한 증거는 아직 없다. 허용된 전용 실행 환경/자원 프로파일을 확인한 후 별도로 재검증해야 한다.
2. 릴리스 consistency 검사는 종료 0이지만 기존 `v1.4.1` 태그가 현재 HEAD의 조상이 아니고 워크스페이스가 `1.4.0`이라는 계보 경고를 남긴다. 이번 작업은 merge, tag, release, publish를 승인하거나 수행하지 않았다.
3. checkout에는 다른 세션의 수정이 많다. 여기서 기록한 결과는 검사 당시의 작업 트리에만 해당한다.
4. `npm run check`와 한정 테스트를 통과했으며, 제품 전체 e2e/배포/실사용 런타임 검증을 뜻하지 않는다.

## 사용한 skills와 직접 검토

- `using-agent-skills`, `programming`, `debugging`, `pi-worktree`, `adaptorch`, `adaptorch-synthesize`, `code-review-and-quality`를 해당 단계에 적용했다. 앞서 읽은 `ponytail`의 최소 변경 원칙도 유지했다.
- 반응형 디자인과 마케팅 skills는 이 작업과 무관해 사용하지 않았다.
- 수정 범위가 작아 위임 없이 루트 에이전트가 직접 구현하고 검토했다.
- 자체 검토에서 테스트 의미, manifest/lock 정합성, 생성기 재현성, 원본 릴리스 문구 보존, 기존 변경 보존을 대조했다. 런타임 기능 확장이나 새 의존성은 없다.
- 제안 커밋 메시지: `fix: coding-agent 의존성 선언과 패키지 회귀 테스트 타입 정렬`.
- 실제 stage/commit/push는 하지 않았다.

## 근거 산출물

로컬 근거는 `.omk/tmp/dependency-type-20261017/`에 보존한다.

- `backups/`: 작업 시작 전 관련 파일.
- `typecheck-before.log`: 수정 전 7건 오류.
- `npm-check.log`: 의존성/타입 수정 뒤 드러난 README/changelog 실패 2건.
- `npm-check-final.log`: 전체 검사 통과 원본 출력.
- `shrinkwrap.diff`: 생성 산출물 diff.
- `verify-manifest.py`: AdaptOrch가 실제 실행한 계약 검사.
- `adaptorch-verification.json`: SDK 결과, 실패 stderr와 검사 대상 파일 digest.

이 디렉터리는 로컬 임시 근거이며 배포 산출물이나 fresh clone에 존재한다고 가정하면 안 된다. 이번 후속 작업은 외부 웹 주장이나 논문에 의존하지 않았다.
