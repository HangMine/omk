# GitHub PR 통합과 로컬 빌드

- 날짜: 2026-10-17 KST
- 승인 범위: 원격 main 및 PR #141~#144를 검토/병합한 뒤 로컬 pull과 빌드. 사용자가 전체 PR 통합과 빌드를 승인했다.
- 시작: 로컬 main `8baa7435ff87e33ff6495761b2fb29265fea9cd8`, 원격 main보다 458커밋 뒤, 미커밋 변경 136개 항목.
- 완료: 로컬 main과 origin/main 모두 `0ce36329dc2e5a13e498f00aec22e4998f6d8214`, ahead/behind `0/0`, unmerged 경로 없음.

## 병합 결과

| PR | 내용 | GitHub merge commit |
| --- | --- | --- |
| [#141](https://github.com/dmae97/omk/pull/141) | oversized tool output의 overflow 복구 무한 반복 방지 | `9d06551a92c107eb20b861341aa659c4cfd3eb3d` |
| [#142](https://github.com/dmae97/omk/pull/142) | admission 메시지별 토큰 통계 캐시 | `2766a8071a8f2b6b0584d229dd5b381cdb4324eb` |
| [#143](https://github.com/dmae97/omk/pull/143) | 모델 레지스트리 refresh 입력 캐시 | `482cb14df8f64aa6ffcb92e8067ba84ac4776ea7` |
| [#144](https://github.com/dmae97/omk/pull/144) | 기본 off 단계별 타이밍 로그 | `0ce36329dc2e5a13e498f00aec22e4998f6d8214` |

모두 원격 CI의 secret-scan/build-check-test 성공, PR별 코드와 테스트 검토, 조합 테스트를 확인했다. GitHub 병합에는 검토한 head SHA를 고정했다. 로컬 미커밋 변경은 GitHub에 올리지 않았다.

## 안전한 로컬 반영

1. `.omk/tmp/github-sync-20261017/`에 시작 HEAD, 인덱스 원본, staged/unstaged/binary patch와 변경 파일을 백업했다.
2. `pi-worktree create --base origin/main --json github-sync-20261017`으로 별도 검증 공간을 만들었다. 에이전트 위임은 하지 않았다.
3. PR 4개를 먼저 격리 공간에서 조합했고, 실제 GitHub merge 후 tree가 사전 검증 조합과 동일함을 확인했다.
4. 로컬 수정과 원격 수정은 base/local/remote 3-way로 대조했다. 충돌은 격리 공간에서 해결한 뒤 검사했다.
5. 원격의 `1.4.2` 버전과 기존 릴리스/보안 기록을 유지했다. 이전 로컬 릴리스 초안은 백업에 보존하고 새 버전으로 덮어쓰지 않았다.
6. 로컬 생성 카탈로그는 당시 최신 생성 스냅샷 전체를 그대로 보존했다. 생성 파일의 모델 행을 수작업 병합하거나 외부 provider inference를 호출하지 않았다.
7. 원본 반영 직전에 동시 수정 여부를 다시 확인했다. 다른 세션의 OpenCode Go 문서 갱신도 보존하고 2026-10-09 기록과 함께 유지했다.
8. 원본에서 겹치는 44개 경로만 잠시 기존 HEAD 상태로 맞춰 `git merge --ff-only`를 실행한 뒤 검증된 로컬 residue 199개를 복원했다. 최종 digest가 격리본과 모두 일치했다.
9. 기존 staged 문서 3개는 staged 상태를 보존했다. 원격에 이미 존재하게 된 `.github/RELEASE_NOTES_v1.4.0.md`의 로컬 staged 초안은 별도 백업으로 보존했다.

`reset --hard`, `stash`, blanket checkout, force push, 타 세션 worktree 삭제를 하지 않았다. 검증용 worktree는 로컬 통합 residue와 함께 보존했다.

## 통합 중 필요한 최소 수정

- `packages/coding-agent/src/core/compaction/concurrent-write-policy.ts`: 로컬 compaction 상태/이벤트/오류 분류를 기존 정책 소유 모듈로 모아 새 원격 소스와 결합했다. 순환 의존성과 모듈 크기 baseline을 늘리지 않도록 타입과 콜백 경계를 사용했다.
- `packages/coding-agent/src/core/agent-session.ts`: 위 정책을 소비하도록 정리했다. 원격 overflow 복구 진전 규칙은 유지했다.
- `packages/coding-agent/src/core/extensions/loader.ts`: 실제 확장 로더의 `omk-ai/prompt-hash` subpath 별칭을 추가했다. 새 원격 코드가 이 subpath를 사용하며, 기존 package-root alias만 있으면 `index.js/prompt-hash`를 열려고 실패했다.
- `.omk/extensions/atelier/vitest.config.ts`: 같은 공개 subpath의 소스 별칭을 연결했다.
- `packages/tui/src/tui.ts`, `packages/tui/src/index.ts`, `packages/tui/src/utils.ts`: 원격 렌더링 분리/캐시와 로컬 scrollback 상태 보존 및 public export를 결합했다.
- `packages/tui/test/width-cache-memory.test.ts`: 새 Hangul 빠른 경로가 segmentation을 건너뛰므로 emoji가 포함된 실제 segmentation 입력으로 캐시 제한을 검증했다. 캐시 제한 구현과 assertion 의미를 약하게 하지 않았다.
- manifest/lock/shrinkwrap: 원격 `1.4.2`와 로컬 보안 핀/빌드 스크립트를 함께 유지하고 표준 npm/생성기로 동기화했다. lifecycle scripts는 실행하지 않았다.

## 검토와 검증

리뷰는 PR별 overflow, admission cache, model refresh, timing의 네 범위로 분리했다. 프로젝트 TypeScript 관례, 오류/예산/신뢰 경계, cache 무효화, 계정 정보 로그 노출 여부, 테스트 소비 경로와 크기/순환 ratchet을 직접 확인했다. PR의 human review/comments는 없었다. 큰 PR은 테스트/재현 문서가 주요 부분이었고 기존 PR 경계를 유지했다. 새 원격 PR이나 local residue 공개 PR을 추가로 만들지 않았다.

| 검사 | 관측 결과 |
| --- | --- |
| PR 조합 primary TypeScript/LSP | 통과 |
| PR 조합 핵심 테스트 | 6개 파일, 41개 통과 |
| PR 조합 `npm run build` / `npm run check` | 종료 0 |
| 로컬 residue 포함 AI 회귀 | 12개 파일, 223개 통과 |
| 로컬 residue 포함 TUI `node:test` 회귀 | 119개 통과 |
| 로컬 residue 포함 Atelier 확장 | 56개 통과, 기존 notification 1개 skip |
| 빌드된 oversized-output CLI e2e | 격리된 HOME/agent dir에서 2개 통과. 모델은 로컬 fake server |
| 로컬 compaction/provider/session 테스트 | e2e 제외 155개 통과 |
| 원본 동기화 후 `npm run build` | 종료 0, 7개 workspace 빌드 |
| 원본 동기화 후 `npm run check` | 종료 0, 내부 Node 테스트 422개 통과 |
| 원본 최종 PR/compaction 회귀 | 28개 통과 |
| 원본 최종 Argon/Go 회귀 | 132개 통과 |
| 원본 최종 sidebar 타입/테스트 | 타입 통과, 56개 통과/기존 skip 1개 |
| 원본 TypeScript/LSP, 세션 진단 | 확인한 파일 오류 없음 |
| 원본 `git diff --check` | 종료 0 |
| 원본/원격 commit 비교 | 동일, ahead/behind 0/0 |

신규 격리 checkout의 초기 테스트 실패는 빌드되지 않은 내부 package entry 때문이었고 빌드 후 재검증했다. e2e 첫 실행은 실제 사용자 HOME의 context/MCP 설정이 섞여 preflight에서 실패했다. 격리 HOME/agent dir를 사용해 원래 oversized-output 동작을 확인했으며 제품 보안/신뢰 gate는 완화하지 않았다. 임시 conflict package.json 파일이 원본 검사 대상에 잡힌 문제는 해당 task-owned 근거 파일만 `.conflict.txt`로 보관해 해소했다.

## 빌드와 실행 중 프로세스의 구분

현재 저장소의 빌드된 CLI는 다음으로 `1.4.2`를 확인했다.

```bash
env -u OMK_PACKAGE_DIR -u PI_PACKAGE_DIR node packages/coding-agent/dist/cli.js --version
```

현재 세션이 상속한 `OMK_PACKAGE_DIR`는 별도의 설치 엔진을 가리키므로 단순 `node dist/cli.js --version`은 그 엔진의 `1.4.1`을 표시했다. 이 저장소의 빌드를 했다고 실행 중 사용자 세션이나 별도 설치 엔진이 자동 갱신된 것은 아니다. 설치 런처/엔진 링크는 바꾸지 않았다. 새 코드 사용에는 해당 빌드 진입점으로 새 프로세스를 시작해야 한다.

## 남은 제약

- 기존 로컬 미커밋 변경 199개 경로를 유지했다. 사용자 변경을 묶어 새 commit/push하지 않았다.
- GitHub merge 후 CI가 재실행되는 상태는 각 GitHub PR/Actions에서 별도 관측할 수 있다. 여기서는 merge 전 CI와 merge tree에 대한 로컬 검사/빌드를 확인했다.
- 실제 외부 provider inference, 계정 인증, 배포, npm publish 및 전체 제품 e2e는 수행하지 않았다.
- 이전 작업의 AdaptOrch 제한 환경 컴파일러 차단은 이 GitHub 동기화의 성공으로 해결됐다고 주장하지 않는다.

## 근거 경로

`.omk/tmp/github-sync-20261017/`의 `manifest.json`, `latest/`, `pre-land/`, `resolution-notes.json`, `pr-*-source.diff`, `pr-focused-tests.log`, `overlay-*`, `root-build.log`, `root-check.log`, `root-pr-regression.log`, `root-ai-regression.log`, `root-atelier-tests.log`를 참고한다. 이들은 로컬 근거이며 fresh clone 또는 공개 release에 포함된 것으로 가정하지 않는다.
