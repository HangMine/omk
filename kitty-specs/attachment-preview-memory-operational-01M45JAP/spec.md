# Feature Specification: 첨부 미리보기 메모리 개선 운영 반영

**Date**: 2026-10-05
**Status**: verified source change, operational application verified
**Mission type**: software-dev
**Harness impact**: preserve

## Intent Summary

로컬 OMK 운영자는 반복 이미지 첨부와 삭제, 제출 후에도 이전 미리보기 메모리가 누적되지 않기를 원한다. 이미 구현하고 회귀 검증한 변경을 Spec Kitty로 명세화하고 실제 런처의 로컬 운영 빌드에 반영한다. 기존 사용자 작업 103개와 기존 spec-kit 거버넌스는 그대로 유지한다.

현재 요청은 새로운 제품 설계가 아니라 확인된 결함의 명세 최신화와 운영 적용이다. 사용자는 전용 브랜치와 범위가 한정된 로컬 커밋을 허용했다. 원격 발행, PR, 릴리스, 기존 세션 종료는 승인 범위가 아니다.

## User Scenarios & Testing

### User Story 1: 반복 첨부 후 폐기 (P1)

운영자는 이미지를 붙여 넣고 미리보기를 확인한 뒤 삭제하거나 제출한다.

1. Given 24개의 1MiB 합성 픽셀 버퍼가 각각 표시된 후 폐기됐을 때, When 두 이벤트 루프 턴과 GC가 완료되면, Then 폐기된 backing buffer 24개는 모두 회수되며 현재 활성 첨부 1개는 유지된다.
2. Given 동일 활성 첨부를 동시에 표시하는 미리보기 2개가 있을 때, When 디코딩이 완료되면, Then 디코딩은 1회만 수행되고 두 미리보기 결과는 같다.
3. Given 8개 이미지가 첨부됐을 때, When 최대 3개 타일을 표시하면, Then 표시한 이미지 3개만 디코딩되고 나머지 5개 안내와 모델 전달용 원본은 보존된다.

### User Story 2: 실제 운영 반영 (P1)

운영자는 기존 소스와 빌드를 백업한 뒤 최신 소스를 빌드하고 새 프로세스에서 확인한다.

1. Given 기존 런처가 사용하는 빌드를 백업했을 때, When 새 빌드가 성공하면, Then 같은 런처로 시작한 새 프로세스가 수정된 미리보기를 사용한다.
2. Given 기존 사용자 세션이 실행 중일 때, When 운영 파일이 갱신되면, Then 기존 프로세스는 강제 종료되지 않고 코드 교체 여부는 새 프로세스와 구분해 보고한다.

## Functional Requirements

| ID | Description | Status |
|---|---|---|
| FR-001 | 폐기된 첨부의 미리보기 픽셀은 활성 첨부 소유자가 없어지면 회수 가능해야 한다. | verified |
| FR-002 | 미리보기 재생성 중 같은 활성 첨부의 진행 중 디코딩을 공유해야 한다. | verified |
| FR-003 | 미리보기에 표시되는 최대 3개 이미지에 대해서만 디코딩해야 한다. | verified |
| FR-004 | 브라우저 전용 전역 객체 없이 로컬 터미널에서 실제 이미지 픽셀을 표시해야 한다. | verified |
| FR-005 | 원래 소스, 스테이징 상태와 운영 빌드를 백업하고 검증된 소스를 실제 런처 대상에 빌드해야 한다. | verified |
| FR-006 | 명세, 계획, 작업 패키지, 직접 리뷰와 운영 검증 결과를 Spec Kitty 미션에 기록해야 한다. | verified |

## Non-Functional Requirements

| ID | Description | Status |
|---|---|---|
| NFR-001 | 폐기된 24개 1MiB 버퍼의 테스트 시점 잔류 수는 0이고 활성 버퍼 잔류 수는 1이어야 한다. | verified |
| NFR-002 | 기존 첨부, 폭, 클립보드 테스트 19개는 모두 통과하고 17개 터미널 폭에서 출력 폭을 초과하지 않아야 한다. | verified |
| NFR-003 | 유료 공급자 호출, 의존성 설치와 원격 Git 쓰기는 각각 0회여야 한다. | required |
| NFR-004 | 현재 소스의 관련 메모리 최적화 회귀 52개와 컴파일된 실제 이미지/스트림 검증은 모두 통과해야 한다. | verified |

## Constraints

| ID | Description | Status |
|---|---|---|
| C-001 | 기존 specs/constitution.md, .speckit/와 사용자 소스 작업은 변경하지 않는다. | required |
| C-002 | 커밋은 이 미션의 명세/설정과 첨부 미리보기 수정 4개 파일만 포함하며 기존 작업을 stage하지 않는다. | required |
| C-003 | 공유 체크아웃의 기존 문서 링크 검사 실패를 가드 완화나 unrelated stage로 숨기지 않는다. | required |
| C-004 | 현재 실행 중인 사용자 세션을 종료하지 않는다. core 변경은 새 시작에 적용되며 /reload만으로 현재 모듈 교체를 주장하지 않는다. | required |

## Success Criteria

- SC-001: 반복 첨부 후 폐기한 픽셀의 잔류 수 0, 활성 첨부의 픽셀 잔류 수 1.
- SC-002: 8개 첨부에서 디코딩 3회, 동시 미리보기 2개에서 동일 첨부 디코딩 1회.
- SC-003: scoped 브랜치 전체 검사, 실제 운영 빌드, 컴파일된 회귀와 새 런처 오프라인 smoke exit 0.
- SC-004: 운영 반영 전후 기존 103개 변경 해시와 staged diff 동일, 백업 복구 가능.

## Regression Floor and Limits

동일 task와 synthetic 입력, 같은 버전의 설치 디코더를 사용한다. 기준은 OMK 1.3.0의 확인된 로컬 소스이며 공급자 모델과 요청 예산은 변경하지 않는다. 첨부 유효성 검사, 원본 모델 전달, 스트림 FIFO와 terminal settlement, 세션 컨텍스트 재구성, 터미널 폭과 출력 backpressure는 퇴행할 수 없다. 이 검사는 coding-quality 비교나 SOTA 근거가 아니다.

전체 공유 작업 폴더 검사에는 기존 context-files.md가 미등록 project-context.md를 링크하는 차단이 남아 있다. 이번 변경의 격리 브랜치 검사와 전체 dirty 운영 소스 검사를 구분한다. 메모리 지표는 backing buffer 회수 결과이며 프로세스 RSS나 WASM allocator가 즉시 OS에 메모리를 반환한다는 보장은 아니다.
