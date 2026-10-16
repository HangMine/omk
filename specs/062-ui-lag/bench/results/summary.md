# Spec 062 bench summary

Raw per-process JSONs are archived outside the repo under `/workspace/omk-bench-archive/062/` (ab062, ab062-statsonly, mem1, mem2, single runs, paired TSVs).
Verdicts come from `/workspace/omk-bench-analyst/paired_verdict.py`: d = branch − base, bootstrap 95% CI of the median, sign test.

## Final (stats-only cache, 20 interleaved pairs, load1 1.7–2.6)
| scenario | metric | n | median d | 95% CI | branch<base | sign p | verdict |
|---|---|---|---|---|---|---|---|
| large | enterToRequest.p50 | 20 | -25.59 | -27.50..-22.71 | 20/20 | 0.0000 | SMALL |
| large | enterToRequest.p95 | 20 | -21.17 | -36.76..-8.74 | 18/20 | 0.0004 | - |
| large | preflightToRunAgentPrompt.p50 | 20 | -12.31 | -13.71..-11.12 | 20/20 | 0.0000 | PASS |
| large | preflightToRunAgentPrompt.p95 | 20 | -15.63 | -17.23..-14.67 | 20/20 | 0.0000 | - |
| small | enterToRequest.p50 | 20 | -0.41 | -1.55..1.46 | 11/20 | 0.8238 | PASS(no regression) |
| small | enterToRequest.p95 | 20 | -3.30 | -11.53..0.87 | 14/20 | 0.1153 | - |
| small | preflightToRunAgentPrompt.p50 | 20 | 0.13 | -0.09..0.33 | 7/20 | 0.2632 | PASS(no regression) |
| small | preflightToRunAgentPrompt.p95 | 20 | 0.03 | -0.14..0.47 | 10/20 | 1.0000 | - |

## Earlier (JSON + stats cache, superseded because it retained ~3.5 MiB heap)
| scenario | metric | n | median d | 95% CI | branch<base | sign p | verdict |
|---|---|---|---|---|---|---|---|
| large | enterToRequest.p50 | 20 | -47.92 | -51.83..-43.49 | 20/20 | 0.0000 | PASS |
| large | enterToRequest.p95 | 20 | -52.67 | -64.78..-37.79 | 19/20 | 0.0000 | - |
| large | preflightToRunAgentPrompt.p50 | 20 | -17.71 | -18.25..-16.91 | 20/20 | 0.0000 | PASS |
| large | preflightToRunAgentPrompt.p95 | 20 | -20.75 | -21.54..-19.52 | 19/20 | 0.0000 | - |
| small | enterToRequest.p50 | 20 | -0.09 | -1.12..0.79 | 11/20 | 0.8238 | PASS(no regression) |
| small | enterToRequest.p95 | 20 | -2.61 | -12.16..2.79 | 12/20 | 0.5034 | - |
| small | preflightToRunAgentPrompt.p50 | 20 | 0.03 | -0.03..0.14 | 8/20 | 0.5034 | PASS(no regression) |
| small | preflightToRunAgentPrompt.p95 | 20 | 0.15 | -0.17..0.41 | 8/20 | 0.6476 | - |

## Heap/RSS (large session, ~400k tokens, 10 prompts, after gc×2, 10 interleaved pairs, paired median B−A)
| cache | heap growth Δ | heap after Δ | RSS growth Δ | load1 |
|---|---|---|---|---|
| JSON + stats | +3.52 MiB | +3.93 MiB | +8.56 MiB | 1.8–2.3 |
| stats only (final) | +0.36 MiB (range 0.34–0.36) | +0.77 MiB | −1.89 MiB (noise, range −14.7..+10.4) | 2.4–3.3 |
