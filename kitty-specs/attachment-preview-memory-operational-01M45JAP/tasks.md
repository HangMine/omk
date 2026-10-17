# Work Packages: 첨부 미리보기 운영 반영

## WP01: 검증된 메모리 수정의 운영 반영

Priority: P1. Dependencies: none. Single-branch, direct root-agent execution.

Success: scoped full repository gates and relevant tests pass, canonical build and compiled real-PNG/stream smoke exit 0, original 103 dirty files and index retained. Existing live processes remain owned by the user.

T001 Record the confirmed source defect, valid RED/GREEN results and current Spec Kitty version (WP01)
T002 Validate the four attachment source/doc/test deliverables in the clean local branch (WP01)
T003 Preserve source/index hashes and seven canonical package dist backups (WP01)
T004 Apply the canonical build and verify compiled real image pixels, backing-buffer collection and stream lifecycle (WP01)
T005 Self-review exact staged scope, commit only mission/attachment deliverables and run Spec Kitty validation (WP01)
T006 Record final source/dist bindings, local deployment status and the separate pre-existing shared-checkout gate (WP01)

## Independent Validation

WP01 is one cohesive local bugfix/operational slice, with six subtasks and no parallel agent workflow. Source code already exists from the preceding verified work; this mission re-verifies and applies it rather than inventing a new implementation. Tests are mandatory for this requested completion.

Prompt: `tasks/WP01-operational-attachment-memory.md`.
