# 061 — 창보다 큰 도구 출력 하나로 세션이 멈추는 문제

상태: 초안 (Tech Lead 승인 전, 수정은 아직 넣지 않음)

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

## 제안 수정 (최소, 승인 후 구현)

`agent-session.ts`에 prompt 단위 카운터 `_overflowCompactionsThisPrompt`를 둔다. `_prompt`의 run 시작
(`:2111` 근처)에서 0으로, overflow 분기에서 `_overflowRecoveryAttempts`와 같이 증가시키고,
`:3905` 상한 검사에 `|| this._overflowCompactionsThisPrompt >= MAX_OVERFLOW_RECOVERY_ATTEMPTS`를 더한다.
기존 메시지 단위 리셋(`:1324`, `:1389`)은 건드리지 않는다. (임시 적용 확인: 회귀 테스트 통과, 시나리오 301ms,
coding-agent 전체 8773 테스트 통과. 실패 6개 파일은 main에서도 `open-multi-agent-kit` 미빌드로 import 실패.)

## 수용 기준 (AC)

1. `test/oversized-output-hang.test.ts`가 main(`e28c260`)에서 실패한다: 자식 vitest가 20초 벽시계 가드에 죽는다
   (`timedOut: true`).
2. 수정 후 같은 테스트가 통과한다: 자식 프로세스가 20초 안에 exit 0, 5회 연속.
3. 시나리오 안에서 prompt 1회당 `compaction_start(reason: "overflow")` ≤ 2.
4. 시나리오 테스트 본체(자식 안 `prompt()`)가 2초 안에 끝난다 (임시 수정에서 301ms).
5. 기존 컴팩션·overflow 테스트(`compaction-before-capacity`, `overflow-retry-guard` 등)와 coding-agent 전체
   스위트에 새 실패가 없다.

## 하지 않을 것

- 큰 도구 출력 자체를 자르거나 spill하는 변경(도구 출력 truncation 정책).
- `overflowRetryBlocked` 판정 방식 변경, 컴팩션 cut-point 알고리즘 변경.
- faux provider가 매크로태스크에 양보하게 바꿔 증상만 가리는 변경.
- 스펙 060(`usage + delta`) 범위의 작업.

## 파일

- `packages/coding-agent/test/oversized-output-hang.test.ts` — 회귀 테스트(자식 프로세스 + 벽시계 가드, 프로세스 그룹 SIGKILL).
- `packages/coding-agent/test/scenarios/oversized-output-hang.scenario.test.ts` — 시나리오. `SPEC061_SCENARIO=1`일 때만 실행
  (`OMK_*`는 `test/setup-env.ts`가 지우므로 다른 접두사).
- 수정 예정: `packages/coding-agent/src/core/agent-session.ts`.
