# 063 paired A/B summary (20 interleaved pairs, load1 1.14–2.16)

Raw JSONs archived at /workspace/omk-bench-archive/063/ (not committed).

## paired_verdict.py

| scenario | metric | n | median d | 95% CI | branch<base | sign p | verdict |
|---|---|---|---|---|---|---|---|
| lag | selector.openToRendered.p50 | 20 | -12.62 | -15.46..-12.12 | 20/20 | 0.0000 | PASS |
| lag | selector.openToRendered.p95 | 20 | -19.31 | -20.04..-13.59 | 20/20 | 0.0000 | - |
| lag | selector.registryRefresh.p50 | 20 | 4.87 | 4.16..8.83 | 1/20 | 0.0000 | - |
| lag | selector.registryRefresh.p95 | 20 | 6.91 | 4.07..10.12 | 1/20 | 0.0000 | - |
| lag | selector.setModelApply.p50 | 20 | -0.66 | -0.87..-0.14 | 15/20 | 0.0414 | PASS(no regression) |
| lag | selector.setModelApply.p95 | 20 | -0.67 | -5.76..5.88 | 11/20 | 0.8238 | - |
| render | openModel.p50 | 20 | -14.37 | -15.13..-13.50 | 20/20 | 0.0000 | PASS |
| render | openModel.p95 | 20 | -19.18 | -21.74..-18.19 | 20/20 | 0.0000 | - |
| render | selectModelFrame.p50 | 20 | -0.13 | -0.25..0.12 | 12/20 | 0.5034 | PASS(no regression) |
| render | selectModelFrame.p95 | 20 | 0.17 | -0.20..0.51 | 9/20 | 0.8238 | - |
