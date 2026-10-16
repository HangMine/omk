# 061 — 창보다 큰 도구 출력 하나로 세션이 멈추는 문제

상태: 승인됨 (Tech Lead, 2026-10-17). 최종 설계: 진전 없는 연속 overflow 컴팩션 카운터.

## 문제

64k 창 모델에서 도구 출력 하나가 ~400KB(~100k 토큰)로 창 전체보다 크고, provider가 받은 프롬프트 크기를
usage로 보고하면(`stopReason: "stop"`, `usage.input > contextWindow`, 즉 silent overflow) `session.prompt()`가
끝나지 않는다. 경계는 출력 200KB(완주)와 240KB(멈춤) 사이다.

### 근본 원인

- `packages/coding-agent/src/core/agent-session.ts:3905` 의 overflow 복구 상한
  (`_overflowRecoveryAttempts >= MAX_OVERFLOW_RECOVERY_ATTEMPTS`, 상한 2, `:143`)이 절대 닿지 않는다.
  카운터가 같은 prompt 안에서 계속 0으로 돌아가기 때문이다.
  - `:1389` — `stopReason !== "error"`인 assistant 메시지마다 리셋. 복구 뒤 continuation의 첫 응답(도구 호출,
    usage가 창 안)이 매번 리셋한다.
  - `:1324` — user `message_start`마다 리셋. `Agent.continue()`가 마지막 메시지가 assistant일 때 넣는 빈 user
    메시지(`packages/agent/src/agent.ts:340`)도 여기에 걸린다.
- 그래서 루프가 이렇게 돈다: 도구 실행(400KB) → "ok"(silent overflow) → `_checkCompaction` overflow 분기
  (`:3925`) → 컴팩션 성공, `willRetry` → `agent-session.ts:2125` 의 `while (_handlePostAgentRun())` →
  `agent.continue()` → 빈 user 메시지 → 모델이 도구를 다시 부름 → 반복. 측정: 12초 동안 overflow 컴팩션이
  수십 번, 매번 `tokensBefore` ≈ 112.7k.
- `overflowRetryBlocked`(`compaction/overflow-retry-guard.ts`)는 컴팩션 직후 메시지(요약 + "ok")만 보므로
  창 안이라 막지 못한다. 큰 출력은 재시도 뒤 도구가 다시 만들어 낸다.
- vitest 타임아웃이 안 터지는 이유: faux provider·요약기가 `queueMicrotask`로만 응답하고 세션 파일 I/O가 동기라,
  루프가 매크로태스크(타이머)에 양보하지 않는다. CPU 프로파일(`--prof`)의 대부분은
  `session-compaction-service.ts`(`captureStateLocked`, `readSessionBytes`)와
  `session-manager.ts:267 serializeFileEntries`, `:545 getDurableHeadToken`의 컴팩션 커밋 반복이다.
  실제 provider에서는 네트워크 I/O가 양보하므로 멈춤 대신 끝없는 재요청·컴팩션(비용)으로 나타난다.

## 목표

prompt 한 번 안에서 overflow 복구 컴팩션 횟수를 상한으로 묶어, 창보다 큰 도구 출력 하나가 있어도
`prompt()`가 완주하거나 기존 "Context overflow recovery failed…" 오류로 끝나게 한다.

## 재현 가능한 도구

- 내장 도구는 400KB를 낼 수 없다. `tools/truncate.ts:11-12`(2000줄 / 50KB)로 잘린다:
  `tools/bash.ts`(마지막 2000줄·50KB, 넘치면 임시 파일), `tools/read.ts:160`(`truncateHead`), `tools/grep.ts:288`,
  `tools/find.ts:135`, `tools/ls.ts:135`, `tools/rtk-output.ts:83`.
- MCP 도구는 결과를 자르지 않는다: `mcp/tools.ts:79`(`mapMcpContent`) → `:138`. 상한은 프로토콜 한 줄 16MB
  (`mcp/protocol.ts:11`)뿐이다. 확장·커스텀 `AgentTool.execute` 결과도 자르지 않는다.
- 결론: 400KB 경로는 MCP·확장·커스텀 도구로만 닿는다.

## 수정 (최종 설계)

`agent-session.ts`의 `_overflowRecoveryAttempts`를 "진전 없는 연속 overflow 컴팩션" 카운터로 바꾼다. 상한은 2 그대로다.
- 증가: overflow 분기에서 컴팩션할 때마다(기존과 같음).
- 리셋 ①: 새 사용자 prompt 시작(`_prompt`의 run 시작).
- 리셋 ②(진전): 에러가 아니고 usage(`input + cacheRead`)가 창 안이며, (a) 도구 호출이 없는 응답(텍스트 턴이 창 안에서
  끝남)이거나 (b) 바로 앞 메시지가 `toolResult`인 응답(도구 결과가 창 안에서 소비됨)이다(규칙 B)(`compaction/overflow-recovery-progress.ts` `isOverflowRecoveryProgress`).
- 리셋하지 않음: `continue()`가 넣는 빈 user 메시지(기존 `:1324` 리셋 제거), 재시도, 자동 컴팩션 뒤 재개,
  빈 continuation 프롬프트에 답한 도구 호출(큰 출력이 아직 안 돌아와서 창 안일 뿐이다).
- 상한 도달: `compaction_end`(`reason: "overflow"`, `willRetry: false`)의 `errorMessage`가 사용자에게 보인다.
  마지막 도구 결과가 창보다 크면 다음 문장을 덧붙인다:
  `The output of tool "<name>" (~N tokens) is larger than the W-token context window, so compaction cannot make it fit. …`
  그렇지 않으면 기존 문구를 그대로 쓴다(기존 테스트 2곳의 기대값 유지).

## 진전 규칙 실험 (2026-10-17)

- A: "창 안의 에러 아닌 응답이면 모두 진전" → 400KB 시나리오가 다시 끝없이 돈다(10회 넘게 컴팩션, 45초 가드에 죽음).
  컴팩션 뒤 빈 continuation에 답한 도구 호출이 작아서 창 안이기 때문이다. 기각.
- B(채택): 위 리셋 ② 규칙. 400KB 시나리오는 끝나고(상한 2), 진전 가드(6회)와 텍스트 전용 복구(4회)가 모두 통과한다.
- 직전 규칙(도구 결과 뒤 응답만)은 텍스트 전용 복구에서 세 번째 overflow에 상한이 걸려 실패한다.

## headless 모드

`print-mode.ts`(`omk -p`, `--mode json`)는 `compaction_end`(`reason: "overflow"`, `willRetry: false`, 문구가
`OVERFLOW_RECOVERY_FAILED`로 시작)을 기록하고, prompt가 끝나면 그 문구를 stderr에 쓰고 종료 코드 1을 돌려준다.
세션은 이 경우에도 `prompt_settled: completed`이고 마지막 메시지가 overflow된 "ok"라서, 수정 전에는 "ok"를 stdout에 쓰고 0으로 끝났다.
그 밖의 경우는 동작이 바뀌지 않는다.

## 현실적 usage 규칙

060 리뷰에서 정한 규칙을 지킨다. 모든 시나리오의 faux provider는 실제로 받은 프롬프트 크기
(`estimateContextInputTokens`, system + tools + messages)를 usage로 보고한다. 에러 응답만 usage 0이다.

## 수용 기준 (AC)

1. 멈춤: `test/oversized-output-hang.test.ts`의 첫 테스트가 main(`e28c260`)에서 실패한다. 자식 vitest가 60초 벽시계
   가드에 죽는다(`timedOut: true`). 수정 후에는 60초 안에 exit 0으로 끝난다.
2. 상한: 400KB 시나리오에서 prompt 1회당 `compaction_start(reason: "overflow")` ≤ 2.
3. 오류 표시: 상한에 닿으면 `compaction_end.errorMessage`가 정확히 1개 나오고,
   `/output of tool "out" \(~[\d,]+ tokens\) is larger than the 64,000-token context window/`에 맞는다(AC 1 테스트 안에서 단언).
4. 진전 가드: prompt 한 번, 도구 출력 ~10k 토큰 14회, provider 실효 한도 30k(넘으면 "prompt is too long" 에러).
   overflow 컴팩션 ≥ 3회(실측 6회)가 일어나도 실패한 컴팩션 없이 14번 도구 호출 뒤 "done"으로 끝난다. main에서도 통과한다.
5. continue만으로는 리셋하지 않는다: AC 1이 이것을 고정한다. 빈 continuation 메시지나 그 답의 도구 호출에서
   리셋하면 400KB 시나리오가 다시 끝없이 돈다.
6. 새 테스트를 5회 연속 돌려 모두 통과한다. `npm run check`가 통과한다.
7. 회귀: 기존 overflow·컴팩션 테스트와 coding-agent 전체 스위트에 새 실패가 없다. 이전에 import 실패였던
   6개 파일은 main과 수정본에서 같은 결과여야 한다(새 실패가 있으면 블로커).
8. 텍스트 전용 복구: prompt 한 번, follow-up 사용자 메시지 6개(각 ~12k 토큰), provider 실효 한도 30k. overflow 컴팩션 ≥ 2회
   (실측 4회)가 일어나도 실패 없이 텍스트 응답 7개로 끝난다.
9. headless: 상한 도달 시 text·json 모드 모두 stderr에 같은 문구를 쓰고 종료 코드 1, 다음 prompt는 실행하지 않는다.
   복구에 성공한 overflow 컴팩션(`willRetry: true`)은 종료 코드 0 그대로다(`test/print-mode.test.ts`).

10. end-to-end(`test/oversized-output-hang.e2e.test.ts`, `SPEC061_E2E=1`, 빌드 필요): 실제 `omk -p`(dist/cli.js), mock
    openai-completions(prompt_tokens = 받은 요청 크기/4), 64k 창, 400KB 확장 도구, `OMK_TRUST_PROJECT=0`, Node 22.20.
    수정본은 같은 인자·바뀌는 인자 모두 stderr에 AC 3 문구, 종료 코드 1(~3.5초). main은 같은 인자에서 stdout "ok", 종료 코드 0,
    바뀌는 인자에서 60초 동안 요청 345번 뒤 SIGKILL.

## 위험·차이

- 하네스와 실제 CLI가 다르다. 실제 `omk -p`에는 identical-loop 가드가 있어서, 같은 인자로 도구를 6번 부르면 도구를 막는다
  (작은 tool result "identical loop: big repeated 6 times…" 추가). 그래서 main에서도 같은 인자면 멈추지 않고 "ok"·종료 코드 0으로
  조용히 끝난다. 인자가 매번 바뀌면 가드가 안 걸려서 main은 실제 provider 요청을 끝없이 보낸다(비용).
- 그 작은 결과가 마지막 tool result가 되므로, 오류 문구는 마지막이 아니라 컨텍스트에서 가장 큰 tool result를 보고 고른다
  (`overflowRecoveryFailureMessage`, `test/overflow-recovery-progress.test.ts`).
- 두 경로 모두 "print mode finished but the process was still held open after 2000ms (PipeWrap x3)" 경고가 main에서도 나온다. 061과 무관하다.

## 하지 않을 것

- 큰 도구 출력을 처음부터 자르거나 spill하는 근본 수정(MCP·확장 도구 결과에 상한 두기). 1.4.4 후보다.
- `overflowRetryBlocked` 판정 방식 변경, 컴팩션 cut-point 알고리즘 변경.
- faux provider가 매크로태스크에 양보하게 바꿔 증상만 가리는 변경.
- 스펙 060(`usage + delta`) 범위의 작업.

## 파일

- `packages/coding-agent/test/oversized-output-hang.test.ts` — 회귀 테스트 2개(자식 프로세스 + 60초 벽시계 가드, 프로세스 그룹 SIGKILL, `-t`로 시나리오 선택).
- `packages/coding-agent/test/scenarios/oversized-output-hang.scenario.test.ts` — 시나리오. `SPEC061_SCENARIO=1`일 때만 실행
  (`OMK_*`는 `test/setup-env.ts`가 지우므로 다른 접두사).
- `packages/coding-agent/src/core/agent-session.ts` — 카운터 리셋 위치(+4/−4).
- `packages/coding-agent/src/modes/print-mode.ts`, `test/print-mode.test.ts` — headless stderr·종료 코드 1.
- `packages/coding-agent/test/oversized-output-hang.e2e.test.ts` — 실제 CLI end-to-end(게이트).
- `packages/coding-agent/test/overflow-recovery-progress.test.ts` — 오류 문구가 가장 큰 tool result를 고르는지.
- `packages/coding-agent/src/core/compaction/overflow-recovery-progress.ts` — 진전 판정과 오류 문구(새 파일, module-size 상한 때문에 분리).
