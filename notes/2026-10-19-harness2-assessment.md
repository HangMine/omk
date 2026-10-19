# Harness² 적용 가능성 평가 (2026-10-19)

## 결론

- **런타임 의존성으로 직접 통합하지 않는다.** Harness²는 Python 3.12 기반의 연구용 하네스 최적화 프레임워크이며, OMK의 TypeScript 런타임과 제품 경로가 다르다.
- **오프라인 하네스 최적화 실험으로는 유용하다.** Propose–Probe–Compose, contrastive evidence, invariant/domain 편집 분리, 도메인별 경험 라이브러리는 OMK의 프롬프트, 스킬, 서브에이전트를 개선하는 데 참고 가치가 높다.
- **WorkBuddy-Bench를 OMK 성능 증거로 바로 사용할 수는 없다.** Harness²의 WorkBuddy-Bench는 OpenCode/Codex 실행기를 전제로 하고, Tencent의 territorial license와 Docker/Vertex 의존성이 있다. OMK WorkBuddy 프로바이더와 이름만 인접할 뿐 같은 측정 대상이 아니다.

## 확인한 소스

- Harness² 저장소: <https://github.com/google-research/harness2>
- 평가 시점 commit: `1cfe254e8d25b15f37048c3730134686abe60335`
- 라이선스: Apache-2.0. `third_party/`와 벤치마크 데이터는 upstream 라이선스를 따른다.
- 핵심 인터페이스: `harness2/substrate/base.py`, `harness2/core/spec.py`, `harness2/core/tree.py`
- 벤치마크: `harness2/benchmarks/lab.py`, `jobbench.py`, `workbuddy.py`
- OMK 하네스 표면: `packages/agent/src/harness`, `packages/coding-agent/src/core`의 skills, subagent, prompt, hook, compaction, provider resilience
- OMK 정적 하네스 감사: `.omk/harness-graph/README.md`

## 적용성 판단

| 축 | 판단 | 근거 |
|---|---|---|
| 코드 재사용 | 낮음 | Python 3.12와 OpenCode/Codex substrate 전제. OMK는 TypeScript CLI와 자체 provider/stream 계층을 사용한다. |
| 아키텍처 차용 | 중간 | `Substrate`와 `BenchmarkAdapter` seam은 깔끔하지만 OMK용 surface, installer, launcher, trajectory renderer가 모두 새로 필요하다. |
| 런타임 기능 | 낮음 | Harness²는 실행 중 에이전트 기능이 아니라 벤치마크 기반 하네스 최적화 도구다. |
| 오프라인 최적화 | 중간~높음 | 실제 task trajectory를 비교해 프롬프트/스킬/서브에이전트 편집을 제안하는 방법론은 OMK에 유효하다. |
| WorkBuddy-Bench | 낮음 | OpenCode/Codex runner, Docker, Tencent license, Vertex judge 전제. OMK substrate와 judge 연결이 별도 작업이다. |
| 즉시 제품 배포 | 없음 | 검증된 OMK substrate, task suite, judge, 비용, 라이선스 승인이 아직 없다. |

## OMK에 이미 있는 것

Harness²의 8개 편집 표면과 OMK의 대응:

- system prompt: `packages/agent/src/harness/system-prompt.ts`, prompt templates
- guardrails: command safety, `domain-loadouts`, provider resilience
- memory: compaction, project context, tencent memory
- tool guidance: tool registry와 tool descriptions
- subagents: `subagent-orchestration`, `subagent-loop-guard`, `pi-worktree`
- skills: `skills.ts`, `skill-search.ts`, `active-skill-state.ts`, skill picker
- scripts: tools와 shell
- plugins: extensions, hooks, MCP

즉 **구성요소는 이미 거의 다 있다.** 빠진 것은 “여러 후보 하네스를 실제 task에서 돌려 contrastive evidence로 편집하고, 채택한 하네스와 교훈을 다음 task로 축적하는 폐루프”다. `.omk/harness-graph`는 정적 wiring/dead-edge 감사이며, Harness²의 성능 기반 편집 루프와는 다른 층이다.

## 유용한 차용점

1. **Propose–Probe–Compose**: 동일 task에서 base와 후보 하네스를 실행하고, trajectory 차이를 근거로 편집한다.
2. **Invariant vs domain 편집 분리**: 일반 규칙과 도메인 규칙을 분리해 과적합을 줄인다.
3. **On-demand 우선 원칙**: always-on 텍스트를 늘리지 않고 skill/script/subagent/plugin을 우선한다.
4. **검증 규칙**: 모든 skill은 trigger line이 있어야 하고, always-on 예산을 넘으면 안 되며, skill이 부르는 script는 같은 제안에 포함되어야 한다.
5. **Evidence boundary**: rubric/answer key를 proposer에게 주지 않고, trajectory와 산출물만 evidence로 준다.
6. **Persistent library**: 채택된 하네스와 교훈을 도메인별로 축적하되, task 순서와 seed를 고정한다.

## 제안하는 최소 파일럿

제품 코드를 건드리지 않고 별도 worktree 또는 `research/`에서 진행한다.

1. **OmkSubstrate 스파이크**
   - editable tree: `AGENTS.md`, `.omk/skills/<name>/SKILL.md`, `scripts/*.py`, `subagents/<name>.md` 또는 OMK extension 정의
   - install: temp workspace에 tree를 materialize하고 `omk -p --no-session --mode json` 실행
   - trajectory: OMK JSON event를 `[ACTION]/[OBSERVATION]/[ERROR]`로 렌더링
   - 위험: OMK의 skill/subagent 로딩 우선순위와 project settings를 그대로 재현해야 한다.
2. **작은 task suite**
   - WorkBuddy code subset 2~3개 또는 OMK 내부의 실제 coding task 2~3개
   - judge는 별도 모델로 하고, 가능하면 rule 기반 check를 우선한다.
3. **비교**
   - baseline 대비 k=1 Propose–Probe–Compose 1회
   - task당 rollout 4회, improver session 3회가 기본 예산이다.
   - 성공 기준: held-out task에서 재현 가능한 개선, 기존 테스트/보안 회귀 없음, 편집 diff가 사람이 검토 가능한 크기.
4. **채택 조건**
   - 2개 이상 task에서 개선이 재현되고, judge 편향, 데이터 누출, 라이선스 검토를 통과할 때만 OMK-native `omk harness optimize` 같은 opt-in 표면을 검토한다.

## 미검증 및 잔여 위험

- 실제 Harness² benchmark는 실행하지 않았다. `gcloud`가 없고 `GOOGLE_CLOUD_PROJECT`와 Vertex 자격 증명이 설정되지 않았다.
- WorkBuddy-Bench는 Docker와 Tencent license 검토가 필요하다. 공개 rubric이 웹에서 접근 가능하므로 executor 네트워크 제한이 필요하다.
- Harness²의 seed는 task 순서만 섞고 model sampling은 제어하지 않는다. 동일 결과의 재현성을 주장하려면 별도 반복, 분산 측정이 필요하다.
- LLM judge는 편향과 비결정성이 있다. rule 기반 judge가 가능한 task를 우선해야 한다.
- 프롬프트/스킬 최적화는 benchmark overfitting 위험이 있다. held-out task와 사람 검토가 필수다.
- OMK의 skill/subagent 로딩은 파일 트리 하나로 환원되지 않는다. surface 매핑이 잘못되면 실제 런타임과 다른 하네스를 최적화하게 된다.
- Harness²는 “not an officially supported Google product”이며 연구 코드다. 유지보수, 보안 패치를 기대하지 않는다.

## 로컬 검증 증거

- Python 3.12.3, uv 0.12.23 환경에서 `uv pip install -e .` 성공.
- `harness2-demo --output /tmp/harness2-demo --k 2`: `2 tasks completed; 0 failed`, R=4k/P=3k ledger 확인.
- `python -m unittest tests.test_workflow -v`: 5 tests OK.
- 환경 확인: Docker, Node, Bun 있음. `gcloud` 없음, `GOOGLE_CLOUD_PROJECT` 없음.

## 최종 판정

- **DESIGNED**: 오프라인 파일럿 설계 완료.
- **IMPLEMENTED**: OMK 제품 코드 변경 없음.
- **WIRED**: 없음.
- **VERIFIED_LOCAL**: Harness² 자체 demo와 unit tests만 검증.
- **BLOCKED**: 실제 benchmark, OMK substrate, judge, 라이선스, 자격 증명.
- **배포**: 런타임 배포 없음. 파일럿 결과가 나오기 전에는 OMK에 의존성을 추가하지 않는다.

## 1.5.3 포함 여부 재판정 (2026-10-19, 배포 마무리 기준)

결론: **1.5.3 런타임 의존성, 기능으로 넣지 않는다.** 근거는 소스와 실행 결과다.

### 확인한 사실

- 평가 commit은 `1cfe254e8d25b15f37048c3730134686abe60335` (2026-10-14), 라이선스 Apache-2.0, 저장소는 비보관 상태다.
- `pyproject.toml`은 `requires-python >=3.12,<3.14`, 런타임 의존성 0개, 콘솔 스크립트 7개다. Python 패키지이므로 OMK TypeScript 런타임에 직접 링크할 수 없다.
- `harness2/core/spec.py`의 seam은 `SubstrateLike` + `BenchmarkAdapter`이고, 실행기는 `opencode`/`codex` 두 개뿐이다. `CHANNELS = ("claude_cli", "opencode")`이며 OMK substrate는 없다.
- `harness2/substrate/base.py`가 요구하는 것은 `surface()`, `materialise()`, `execute()`, `read_trajectory()`, `preflight()`다. OMK용으로는 다섯 메서드와 trajectory 렌더러를 새로 구현해야 한다.
- `harness2/core/tree.py`의 editable surface는 `AGENTS.md` 계열 always-on, `.opencode`/Codex 스킬 디렉터리, `sub_agents/<name>/AGENT.md`, `scripts/*.py`, hooks JSON, plugin `.ts`를 전제한다. OMK의 `SKILL.md` 탐색, `packages/agent` 하네스, extension/hook 로딩과 1:1로 대응하지 않는다.
- `dependencies/README.md`에 따르면 WorkBuddy-Bench는 Tencent custom license이고 EU 사용 제한이 있다. JobBench/LAB도 별도 dataset 라이선스를 가진다.
- `docs/SETUP.md`는 Linux, Python 3.12, `gcloud`, Vertex ADC, Docker(WorkBuddy), Pandoc/Poppler(LAB)를 요구한다. 현재 환경에는 `gcloud`와 `GOOGLE_CLOUD_PROJECT`가 없다.
- seed는 task/domain 순서만 섞고 model sampling은 제어하지 않는다(`core/schedule.py`). 재현성 주장에는 별도 반복 측정이 필요하다.

### 실행 증거 (2026-10-19 재확인)

- 새 clone에서 `uv venv --python 3.12 .venv && uv pip install -e .` 성공.
- `harness2-demo --output runs/demo --k 2`: `2 tasks completed; 0 failed`.
- `python -m unittest tests.test_workflow`: 5 tests OK.
- 이는 Harness² 자체의 offline demo이며 OMK 하네스 개선 증거가 아니다.

### 1.5.3에 넣을 수 있는 것 / 없는 것

| 항목 | 판단 | 이유 |
| --- | --- | --- |
| 런타임 의존성 추가 | 없음 | Python 3.12 전용, OMK는 Node 22+ TypeScript. 배포 표면이 7개 lockstep npm 패키지다. |
| CLI `omk harness optimize` 표면 | 없음 | substrate, judge, task suite, 비용, 라이선스 승인이 모두 선행돼야 한다. |
| `AGENTS.md`/skill 정적 검증 규칙 차용 | 조건부 | always-on 예산, trigger line, skill이 부른 script 동봉, frontmatter name 일치 검증은 OMK에 유용하지만 **별도 스펙**이 필요하다. |
| WorkBuddy-Bench를 OMK 성능 근거로 사용 | 없음 | 실행기, judge, 라이선스가 다르고, OMK WorkBuddy 프로바이더와 측정 대상이 다르다. |
| 문서 참고 | 있음 | 이 문서와 `.omk/harness-graph`의 정적 감사가 이미 그 역할을 한다. |

### 1.5.3에 넣지 않는 결정의 결과

- 새 의존성, 새 npm 패키지, 새 CLI 명령, 새 설정 키가 없다. 따라서 1.5.3의 릴리스 표면과 shrinkwrap은 변하지 않는다.
- Harness² 방법론은 `research/` 또는 별도 worktree 파일럿으로 남긴다. 제품 코드와 배포물에는 영향이 없다.

### 파일럿 착수 조건 (재개 시)

1. `OmkSubstrate` 스파이크: `surface()`가 OMK의 always-on 파일, `.omk/skills/<name>/SKILL.md`, subagent 정의, hooks를 실제 로더에서 파생해야 한다. 하드코딩 금지.
2. task suite: OMK 내부의 실제 coding task 2~3개 또는 라이선스가 명확한 code subset. rubric/answer key는 proposer에게 주지 않는다.
3. judge: rule 기반 check 우선, LLM judge는 held-out task와 사람 검토를 동반한다.
4. 채택 조건: 2개 이상 task에서 재현 가능한 개선, 기존 테스트, 보안 회귀 없음, 편집 diff가 사람이 검토 가능한 크기, 라이선스, 데이터 누출 검토 통과.
