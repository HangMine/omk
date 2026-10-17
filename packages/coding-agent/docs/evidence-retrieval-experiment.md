# Evidence retrieval experiment

This source-only, opt-in experiment compares three ways to present synthetic execution logs under one context budget. It does not change OMK tools, session storage, compaction, or model requests.

## Run

From a development checkout with its existing dependencies:

```bash
# Small smoke run, three fresh worker processes
node --import tsx packages/coding-agent/scripts/evidence-retrieval/run.ts \
  --runs 1 --mib 1 --budget 2048 --out /tmp/omk-evidence-smoke

# Twenty independent 100 MiB inputs, sixty workers in sequence
node --import tsx packages/coding-agent/scripts/evidence-retrieval/run.ts \
  --runs 20 --mib 100 --budget 2048 --out /tmp/omk-evidence-full
```

The output directory must not already exist and its parent must exist. The full run retains about 2 GiB of synthetic logs. It does not read personal transcripts, call models, download dependencies, or contact AdaptOrch. Run local AdaptOrch command verification separately when required.

Limits: 1–20 inputs, 1–100 MiB per input, 0–65,536 estimated context tokens. Each worker has a 120-second wall deadline and 1,024 MiB V8 old-space limit. A worker failure stops the run with a nonzero exit code; partial artifacts remain for inspection and no success report is written. The index accepts at most 256 evidence records, 64 KiB per log line and 256 MiB per source. These limits are not an OS sandbox or a total process-memory guarantee.

## Arms

| Arm | Behavior |
| --- | --- |
| `full` | Hypothetical eager loading of the entire file, then OMK's tail truncation to the common budget. This is **not** current OMK behavior. |
| `tail` | Current `OutputAccumulator`, fed a stream, retaining bounded display text and an owner-only raw-output file. The experiment removes only its own temporary duplicate after closing it. |
| `indexed` | Stream the log into a metadata-only index, discover IDs and topics, then fetch selected original records by byte range and SHA-256. Reuse `planPromptContextBudgetV2` for admission. |

All arms read the same bytes in separate processes. Order rotates by input, but the filesystem cache is warm. Index construction is included in peak RSS and total time; `preprocessMs` exposes it separately. RSS is the worker's process-lifetime high-water mark, including Node and the TypeScript loader. `heapUsedBytesAtEnd` is not peak heap.

The index summary contains source and record hashes, offsets, topics and record kinds, not answer text. Source identity is checked before and after reads; changed files, invalid records, duplicate IDs, out-of-range offsets and digest mismatches fail closed. The CLI only creates and reads its own fixtures; it is not a general parser for untrusted sessions or arbitrary historical indexes.

## What the numbers mean

- `evidenceRecall`: fraction of query-relevant known facts appearing exactly in the materialized context. An ID in the summary alone receives no credit.
- `unknownReasonAccuracy`: fraction of query-relevant unknown records whose exact reason appears in the materialized context. Missing records receive no credit. The injected `timeout` / `heap` outcomes do **not** prove real host timeout/OOM detection.
- `estimatedTokens`: existing OMK `ceil(text.length / 4)` heuristic, used consistently for the budget and all arms. Includes the complete index summary, pointer metadata, selected raw records and framing. It is not an exact tokenizer or a provider bill.
- `maxRssKiB`, `totalMs`, `preprocessMs`: measured process RSS and elapsed times. Fixture generation happens in the parent and is excluded from every arm.
- `answerAccuracy: null`, `modelCalls: 0`: no LLM solved a task. Retrieval success is not semantic correctness or a production performance claim.

The fixture has twelve structured evidence records across four topics, with head, interior and tail placements among repetitive trace lines. Each topic has two completed facts and one explicit unknown. The selector receives only the topic and log path; the parent retains the gold answers. Exact topic lookup is deliberately simpler than semantic search. Every input/arm pair is sampled once, so the report does not establish statistical significance.

`report.json` contains per-trial and aggregate results, runtime metadata and experiment-source hashes. Each input has a `.gold.json` oracle, a metadata-only `.index.json`, and a `.context.txt` for each arm. Keep these together when reviewing a result. A local AdaptOrch receipt should additionally bind the imported OMK source, verifier revision, exact commands and output hashes.

## Tests and startup identity

```bash
cd packages/coding-agent
node ../../node_modules/vitest/dist/cli.js --run \
  test/evidence-retrieval.test.ts test/evidence-retrieval-cli.test.ts \
  test/control-panel-brand.test.ts
```

The built-in startup header keeps OMK as the product and labels AdaptOrch as optional verification. This text neither enables an integration nor changes a verification verdict. Quiet startup and custom extension headers still take precedence. See [AdaptOrch onboarding](adaptorch-onboarding.md).

Inspiration: [REA Agents v6.4.0](https://github.com/morluto/rea/releases/tag/rea-agents-6.4.0), published October 11, 2026, describes retained Evidence discovery, selected views and resource-limit unknowns. This experiment evaluates a small analogous retrieval mechanism, not REA itself.
