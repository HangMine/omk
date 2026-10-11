<p align="center">
  <img
    src="readmeasset/omk-hero.svg"
    alt="OMK, Open Multi-Agent Kit. Make done pass a check. The mark shows a four-stage control loop with three routed lanes."
    width="100%"
  />
</p>

<h1 align="center">OMK</h1>

<p align="center">
  <strong>Open Multi-Agent Kit</strong><br />
  Make “done” pass a check.
</p>

<p align="center">
  A terminal coding agent with model switching and explicit, test-backed goals.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm version" src="https://img.shields.io/npm/v/open-multi-agent-kit?style=flat-square&label=npm" /></a>
  <a href="https://www.npmjs.com/package/open-multi-agent-kit"><img alt="npm downloads per month" src="https://img.shields.io/npm/dm/open-multi-agent-kit?style=flat-square" /></a><br />
  <a href="https://github.com/dmae97/omk/releases/latest"><img alt="latest GitHub release" src="https://img.shields.io/github/v/release/dmae97/omk?style=flat-square&label=release" /></a><br />
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/npm/l/open-multi-agent-kit?style=flat-square" /></a>
  <img alt="supported Node.js version" src="https://img.shields.io/node/v/open-multi-agent-kit?style=flat-square" />
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#what-runs-by-default">Default or opt-in?</a> ·
  <a href="#evidence-and-limits">Evidence and limits</a><br />
  <a href="#faq">Choosing OMK</a> ·
  <a href="packages/coding-agent/docs/index.md">Documentation</a>
</p>

---

## Why OMK

An AI saying “done” is not an acceptance check. With `/goal verify`, you choose
the command that checks your goal. OMK runs it after each settled turn and
completes the goal only when it passes on the current workspace. A later edit
makes that evidence stale. The result is only as strong as the check you choose.

```text
/goal Fix the failing test without changing its assertions.
/goal verify node --test check.test.mjs
```

Use a test that exists in your project, or follow the
[small, reproducible goal demo](packages/coding-agent/docs/goal-demo.md).
This is an explicit workflow; ordinary prompts do not enable the gate.

Choose a model, work on your repository, then switch models with `/model` when
another one suits the next step. The conversation stays in the same session.
You can also stop and return later with `/resume` or `omk -c`.

OMK is a standalone CLI, not a plugin for Claude Code or OpenCode. It supports
[subscription providers, API keys, and local models](packages/coding-agent/docs/providers.md).
Start with one agent that reads files, edits code, and runs commands. Add
subagents or explicit verification workflows when you need them; neither is
required for your first task.

## Quick start

Install the standalone binary (no Node.js needed; the installer verifies the
release's `SHA256SUMS` and refuses a mismatch), then start in your repository:

```bash
curl -fsSL https://github.com/dmae97/omk/releases/latest/download/install.sh | sh
cd your-project
omk
```

With Node.js 22.19 or newer you can use npm instead:
`npm install -g open-multi-agent-kit --ignore-scripts`, or run
`npx --ignore-scripts open-multi-agent-kit` without a global install.

1. On a first run OMK opens `/login` for you: sign in with a subscription or an
   API key. An existing Claude Code or Codex CLI login can be reused with
   `omk provider adopt`.
2. Run `/model` to choose another available model at any time.
3. Try a read-only first task:

```text
Summarize this repository and identify the commands used to check it.
Read the project configuration to support your answer. Do not edit files.
```

After the reply, use `/model` to choose another configured model and ask it to
review the answer. You stay in the same session. This is manual model switching,
not parallel agents or an independent correctness check.

Ready to see a test-backed goal? Try the [goal demo](packages/coding-agent/docs/goal-demo.md),
then share your result or a reproducible failure in a
[GitHub issue](https://github.com/dmae97/omk/issues). If this workflow is useful,
[star OMK](https://github.com/dmae97/omk) to help other developers find it.

For a bug fix, name the failing behavior and ask for a regression test, the
smallest fix, and the check commands with their exit codes. Review the diff and
those results yourself; a request to run tests does not enable a verification
gate.

Built-in local bash requires `sandbox-exec` on macOS or `bwrap` plus
unprivileged user namespaces on Linux (`sudo apt install bubblewrap` on Debian
and Ubuntu). It blocks network access and fails closed if the backend is missing.
`omk doctor` checks the runtime, credentials, the model a first session would
pick, and the sandbox, and prints the fix for this machine. See
[Bash sandbox setup](packages/coding-agent/docs/sandbox-setup.md), the
[safety boundary](#verification-boundary) and the
[full quickstart](packages/coding-agent/docs/quickstart.md).

## What runs by default

A fresh install starts one agent/tool loop after provider setup. It does not
turn each prompt into a multi-agent workflow or automatically certify its
answer.

| Capability | Fresh-install behavior | Where to start |
| --- | --- | --- |
| File editing, shell commands, saved sessions | Built in; tools run when called by the agent | [Usage](packages/coding-agent/docs/usage.md), [sessions](packages/coding-agent/docs/sessions.md) |
| Tool-call scheduling | `dag-v2` schedules resource conflicts within the agent loop; it does not launch a team | [Runtime algorithms](packages/coding-agent/docs/runtime-algorithms.md#tool-scheduling-and-settlement) |
| Subagents | Optional extension; load it and supply agent definitions | [Subagent setup and examples](packages/coding-agent/examples/extensions/subagent/README.md) |
| MCP servers, extra skills and extensions | Require configured servers or installed resources | [MCP](packages/coding-agent/docs/mcp.md), [skills](packages/coding-agent/docs/skills.md), [extensions](packages/coding-agent/docs/extensions.md) |
| Durable goals | Built in; `/goal <objective>` continues after each settled turn, up to 8 rounds. With `/goal verify <command>` the goal completes only when that check passes on the current workspace | [Acceptance checks](packages/coding-agent/docs/run-protocol.md#acceptance-checks) |
| Protocol verification and advisory judging | Explicit API/workflow opt-in; not a gate on ordinary prompts | [Run protocol](packages/coding-agent/docs/run-protocol.md) |
| Verified runs (`omk run`) | Opt-in CLI and SDK on Linux with `bwrap`; runs an approved command in an isolated copy, checks the result, and supports resume, cancel and cleanup | [Verified run](packages/coding-agent/docs/verified-run.md) |
| Context budgeting | Off by default | [Settings](packages/coding-agent/docs/settings.md#context-budget) |
| AdaptOrch integration | Optional and separate; no service calls by default | [OMK + AdaptOrch](#omk--adaptorch) |

The internal lane launcher and automatic command-sharding primitives are not
connected to the default CLI path. Installing their packages is not the same
as enabling an orchestration workflow.

## Evidence and limits

One dated comparison is available below: OMK and mini-SWE-agent on
Terminal-Bench 2.1 with the same base model. The observed success-rate
difference is not statistically significant, and the time budgets differed.
It does not establish overall harness superiority, multi-agent gains, or how
much verification reduces false completion.

OMK targets state-of-the-art quality as a CLI coding-agent harness.
SOTA is not verified.

The evidence you can inspect today covers specific failure modes:

| Behavior covered | Regression evidence | Scope |
| --- | --- | --- |
| Missing test observations produce `inconclusive`; a required failing test produces `fail` | [Protocol tests](packages/protocol/test/protocol.test.ts) | Explicit protocol evaluation, without a waiver |
| Changed artifacts, wrong command bindings, or missing ledger evidence block acceptance | [Evidence binding tests](packages/coding-agent/test/evidence-gate-binding.test.ts) | Strict evidence gate and selected workspace scope |
| A relevant workspace mutation after verification makes the receipt stale | [Freshness tests](packages/coding-agent/test/evidence-freshness.test.ts) | Configured receipt and mutation tracking |
| A durable goal with an approved acceptance check completes only on a passing receipt, and an edit after the check makes that receipt stale | [Goal acceptance tests](packages/coding-agent/test/goal-controller-acceptance.test.ts), [live loop tests](packages/coding-agent/test/suite/goal-acceptance-loop.test.ts) | Approval held by the running OMK process; git work tree; static command lines |
| An effect that may still be live keeps its resource claims through expiry, cancellation and authority restart, until a supervisor confirms termination | [Coordination broker tests](packages/coding-agent/test/coordination-broker.test.ts) | In-process broker with canonical claim keys; no OS fencing |
| A publication is refused unless its read versions, parent revision and receipt binding all still match | [Publication tests](packages/coding-agent/test/coordination-integration.test.ts) | Single accepted snapshot pointer; no multi-file filesystem atomicity |
| Cancellation after dispatch is never reported as cancelled-before-dispatch; the outcome stays unknown until settled | [Operation lifecycle tests](packages/coding-agent/test/coordination-operation.test.ts) | Pure state machine; does not itself stop a remote effect |
| Zero trials is reported as absent evidence rather than zero risk, and a point estimate is not an error rate | [Risk bound tests](packages/coding-agent/test/metacognition-risk.test.ts) | Binomial model under a fixed policy and adequately independent samples |

These tests exercise the gates, not the rate at which they catch real bugs.
An ordinary prompt finishes when its tool loop and queued work settle;
`prompt_settled` is not a correctness verdict.

A useful comparison must hold the model, provider configuration, tasks, budget,
and tool permissions constant, and label default versus opt-in workflows.
Report task success, cost, latency, and false completion (reported complete but
failing the declared checks), with its denominator and per-task outcomes.
The [measurement protocol](packages/coding-agent/docs/metrics.md#controlled-comparison-contract)
defines the reproducibility and privacy requirements. `omk stats` shows local
turn costs and tool failures; it does not score task correctness.

If you evaluate OMK, share a sanitized report and reproduction steps in a
[GitHub issue](https://github.com/dmae97/omk/issues). Include failed and
interrupted runs, not just successful examples.

### Terminal-Bench 2.1 · R8

<p align="center">
  <img
    src="readmeasset/omk-terminal-bench-r8.png"
    alt="OMK versus mini-SWE-agent 2.4.6 on Terminal-Bench 2.1 with Grok-4.7 xhigh. Primary success: 75.8% (200/264) versus 71.6% (189/264). Recorded cost per graded trial: $0.581 versus $0.759. Median time: 482 versus 376 seconds. Success difference: +4.2 percentage points, 95% CI minus 1.9 to plus 10.2; not statistically significant. OMK had 150 additional seconds per trial and used an evaluation build."
    width="1200"
  />
</p>

**75.8% observed success · approximately 23% lower recorded model cost per
graded trial.** OMK took longer: 482 s median, compared with 376 s for
mini-SWE-agent. Both used xAI `grok-4.7` at reasoning effort `xhigh` in a
2026-10-05–06 KST run of 89 tasks, with 3 trials per task per harness.

The +4.2 percentage-point success difference is **not statistically significant**
(95% task-level paired-bootstrap CI: −1.9 to +10.2 pp). OMK alone had **150 s
extra per trial** for snapshots, so the time budgets were unequal. This result
covers the **1.3.0 evaluation build `78cc483`**, including unmerged changes,
rather than the published npm package. It is not an official leaderboard result.

<details>
<summary>Benchmark data and evaluation limits</summary>

| Harness | Success rate (88 tasks × 3 trials) | Cost per trial (all 267 trials) | Median wall time per trial (all 267 trials) |
| --- | --- | --- | --- |
| OMK | 75.8% (200/264) | $0.581 | 482 s |
| mini-swe-agent 2.4.6 | 71.6% (189/264) | $0.759 | 376 s |

- The difference is +4.2 percentage points with a 95% confidence interval of
  [−1.9, +10.2] (task-level paired bootstrap). The interval includes zero, so
  this is **not** a statistically significant improvement.
- OMK cost about 23% less per trial but was slower: 482 s median per trial
  against 376 s.
- Audit corrections: trials that tried to read Terminal-Bench sources or
  answers score 0, which turned 4 mini-swe-agent passes and 1 OMK pass into
  failures.
  `prove-plus-comm` is excluded from both sides because our OMK adapter failed
  to start in that task's working directory. Two transient provider errors were
  retried; no trial was excluded.
- OMK failed all three `pytorch-model-recovery` trials because the CLI rejected
  an instruction starting with `- ` (fixed in #84). Without that
  task the difference is +5.4 pp [0.0, +10.7].
- Not a leaderboard run: 3 trials instead of the official 5, our own network
  allowlist and apt cache proxy, and OMK alone had 150 s extra for a workspace
  snapshot used in rescoring.

- Costs count only the graded attempt, excluding prior failed retry attempts and
  42 auxiliary model calls made by code inside one mini-SWE-agent task. They are
  not total experiment spend.

Method, per-difficulty results, audit and reproduction notes:
[Terminal-Bench 2.1 report](packages/coding-agent/docs/benchmarks/r8-terminal-bench-2.1.md).

</details>

[Editable figure](readmeasset/omk-terminal-bench-r8.svg) · [Original report review](https://github.com/dmae97/omk/pull/86)

## OMK//CONTROL

The terminal UI shows the selected model, tools, and session status. Additional
signals depend on the integrations you configure.

<p align="center">
  <img
    src="landing/assets/omk_tui.jpg"
    alt="OMK//CONTROL terminal dashboard showing model routing, tools, and session status"
    width="960"
  />
</p>

The header reads `omk v<package.version> · OMK//CONTROL`; the installed package
version is the source of truth.

## Control loop

<details>
<summary>How scope, routing, verification, and replay fit together</summary>

OMK's provider-neutral coding-agent CLI also exposes a multi-agent control
plane for explicitly configured workflows. The diagram describes that design,
not what every prompt automatically runs.

<p align="center">
  <img
    src="readmeasset/omk-control-loop.gif"
    alt="Animated OMK control loop showing Scope, Route, Verify, and Replay"
    width="900"
  />
</p>

The v0.98.3 SDK rejects incomplete first-party judge responses and exposes
deterministic ties; it is not an automatic TUI judge.

1. Scope the goal, paths, resources, and acceptance predicates. A selected
   orchestration workflow may also supply a DAG; an ordinary prompt remains
   one agent/tool loop.
2. Route work to models, agent skills, MCP tools, and extensions without
   changing the evidence contract.
3. Verify declared checks in explicit evidence workflows. Required failing
   checks block those workflows; advisory judging cannot replace them.
4. Preserve receipts and replay state for bounded session recovery; continue
   durable goals from explicit reducer state.

The animation changes once every 1.5 seconds and contains no flashing. The four
steps above are the complete text alternative.

</details>

## Verification boundary

`AgentSession` built-in local bash uses OS sandbox enforcement by default:
`sandbox-exec` on macOS and `bwrap` plus unprivileged user namespaces on Linux.
Local shell spawns restrict writes to the workspace and OS temporary directory,
disable network access, and fail closed with `sandbox.backend_missing` when an
enforcement backend is unavailable.

This is **not** read-confidentiality or whole-process containment. Other file
tools, extension and custom-tool code, injected or remote `BashOperations`, and
the OMK process keep the permissions of the process running them. Use
[containerization](packages/coding-agent/docs/containerization.md) when the
boundary must cover more than built-in local bash. Explicit evidence workflows
cannot treat missing required evidence as a verified result.

## Providers

<details>
<summary>Provider integrations and published packages</summary>

OMK keeps routing separate from control and evidence. Codex, Claude Code,
OpenCode Zen/Go, Kimi, GLM/ZAI, native xAI/Grok, NVIDIA NIM, and local providers
can participate through `omk-ai` while the run contract stays stable.

Native `xai` keeps subscription OAuth and `XAI_API_KEY` billing separate. See
[provider setup](packages/coding-agent/docs/providers.md),
[provider resilience](packages/coding-agent/docs/provider-resilience.md), and
[Grok integration](packages/coding-agent/docs/grok-harness.md).

## Published packages

| Package | Purpose |
| --- | --- |
| [`open-multi-agent-kit`](packages/coding-agent) | Interactive coding-agent CLI and control plane |
| [`omk-agent-core`](packages/agent) | Agent runtime, tool execution, and DAG scheduling |
| [`omk-ai`](packages/ai) | Unified multi-provider LLM API |
| [`omk-protocol`](packages/protocol) | Versioned run contracts and semantic reducers |
| [`omk-adaptorch-wpl`](packages/adaptorch-wpl) | Work Packet Loop runtime |
| [`omk-book-to-skill`](packages/book-to-skill) | Optional document-to-skill compiler |
| [`omk-tui`](packages/tui) | Differential-rendered terminal UI library |

```bash
npm install omk-agent-core
npm install omk-ai
npm install omk-protocol
omk install npm:omk-book-to-skill@0.98.3
npm install omk-tui
```

</details>

## Repository understanding

<details>
<summary>Optional indexes, retrieval settings, and trust limits</summary>

`v0.97.0` shipped the OpenWiki policy and workflow, but no versioned corpus or
integrity checker. The following integrity/output guards shipped in v0.98.0;
the generated corpus remains optional and is not bundled:

- **`openwiki/`** — absent. The previous untracked corpus was removed after the
  hardened gate proved it carried fabricated evidence: 8 frontmatter symbols
  that no declared source path defines (`AgentLoop`, `getModel`, `DeepWall`,
  `loadExtensions`, `createExtensionRuntime`, `main`), 45 references to `@omk/*`
  package names this repository does not publish, and a
  restatement of this README's `Scope -> Route -> Verify -> Replay` loop as a
  strict engine state machine, which is not what the source implements.
  CI regenerates the corpus; nothing is lost.
- **`scripts/check-openwiki.mjs`** — shipped integrity checker. An `interrupted` corpus
  now fails unless `openwiki/.manual-review.json` binds a review to the exact
  corpus digest, and every frontmatter symbol must bind to one of that page's
  own `source_paths` as a whole identifier.
- **`scripts/check-openwiki-output.mjs`** — output gate. The scheduled workflow
  may write, upload, and open a PR for `openwiki/` and nothing else, so a model
  reading this repository cannot reach `AGENTS.md`, `CLAUDE.md`, or the workflow
  that runs it. The gate runs once before the artifact leaves the read-only
  generating job and again before the PR, because the publishing job holds write
  permissions the first one does not.
- **`.understand-anything/`** — optional local structural graph used by Pi Lens;
  it is not published or injected into prompts by default. To reach a session,
  attach it through OMK's [MCP client](packages/coding-agent/docs/mcp.md) like
  any other server; there is no second, bespoke path for it.

Source and tests remain authoritative. Shipped guards do not turn a generated
index into authority: treat corpus pages as local advisory data and recheck source.

### Retrieval

A corpus no session can read is documentation of a plan, not a feature, so the
pages are now candidates for prompt budgeting. Enable `contextBudget.openwiki`
alongside `contextBudget.enabled`
([settings](packages/coding-agent/docs/settings.md#repository-wiki-retrieval))
and each page becomes a low-priority `evidence` item ranked against the turn's
query. Pages compete for leftover budget and can never displace instructions or
skills; most turns carry titles and declared symbols alone, and a page's text
arrives only when the query earns it.

Admission mirrors `scripts/check-openwiki.mjs` rather than restating it. A
complete corpus at the current `HEAD` offers page text; one whose `HEAD` has
moved offers titles only and is marked stale; an interrupted corpus is refused
unless a review binds to its exact digest. The default is off, and with the
setting off the prompt is byte-identical to one built without a corpus.

</details>

## OMK + AdaptOrch

<a href="https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk">
  <img
    src="readmeasset/omk-adaptorch-banner.svg"
    alt="OMK writes and runs code. AdaptOrch checks what it wrote. correctness_claim: false — it ran, and this is what happened."
    width="100%"
  />
</a>

OMK is this local, MIT-licensed coding agent. AdaptOrch is a separate
proprietary evidence service. Neither requires the other: installing OMK does
not create an AdaptOrch account or make calls to it by default.

For an optional integration, see the [WPL package and clients](packages/adaptorch-wpl/README.md)
and [MCP setup](packages/coding-agent/docs/mcp.md). The WPL package exposes
state, client, and adjudication primitives, not an automatic verification loop
for every CLI prompt.

AdaptOrch's reports carry `correctness_claim=false`; they are not semantic
correctness proofs or OMK harness benchmark results.
[Review AdaptOrch plans](https://adaptorch.com/?utm_source=github&utm_medium=readme&utm_campaign=omk#pricing)
· [Claim boundary](https://adaptorch.com/claim-boundary?utm_source=github&utm_medium=readme&utm_campaign=omk)

<sub>The AdaptOrch name and marks identify that separate proprietary product
and appear here with permission. They are excluded from this repository's MIT
grant — see [LICENSE](LICENSE).</sub>

## Prior art

<details>
<summary>Research references, not OMK benchmark results</summary>

The design decisions behind OMK's context, routing, memory, and orchestration
layers are grounded in published work rather than invented in isolation. Each
row below was retrieved and read directly; claims are at abstract level, which
is the evidence grade this table asserts and no more.

| Paper | Mechanism it establishes | OMK implementation or design reference |
| --- | --- | --- |
| [arXiv:2608.22752](https://arxiv.org/abs/2608.22752) — *The Compaction Cliff in Long-Running AI Agent Memory* | Uniform summarization erodes rules and episodic logs at the same rate; measured safety-rule retention falls to 53% after one compaction and 10% after five. Type-tagged deterministic operators fix it. | Type-aware compaction triage: rule-typed items survive N rounds byte-identical |
| [arXiv:2608.23023](https://arxiv.org/abs/2608.23023) — *Most of the LLM Routing Gap Is Task Type* | Most routing gain is reachable with a fixed task-type table; run-to-run flips must not be credited as wins. | Frozen task-class table plus the 2-run stability rule in the promotion gate |
| [arXiv:2506.16655](https://arxiv.org/abs/2506.16655) — *Arch-Router: Aligning LLM Routing with Human Preferences* | Indirection: a classifier emits a label, a policy table maps label to decision, so models change without retraining. | `classifyTaskV4` plus `TASK_CLASS_THINKING_LEVELS` |
| [arXiv:2605.09894](https://arxiv.org/abs/2605.09894) — *Deterministic vs. LLM-Controlled Orchestration* | Holding model, prompts, and tools constant and varying only execution control, deterministic orchestration matched accuracy, improved worst-case robustness, and cut tokens up to 3.5x. | Deterministic scheduler and planned lanes; execution control is never delegated to the model |
| [arXiv:2608.15565](https://arxiv.org/abs/2608.15565) — *Admission Without Answers* | Label-free admission on execution success alone admits substantial contamination; an accept/abstain/escalate decision is required. | Verified-memory admission design (spec 019), abstain is not stored |
| [arXiv:2608.23471](https://arxiv.org/abs/2608.23471) — *InjecMEM: Memory Injection Attack on LLM Agent Memory Systems* | Single-interaction memory injection is a reproduced attack frame against agent memory. | Retrieved memory is injected only as provenance-tagged data, never fused into instruction position |

Entries include implemented mechanisms and design proposals; check the
[runtime status guide](packages/coding-agent/docs/runtime-algorithms.md) for
availability. The wider survey, including approaches not adopted, is working
material that is not published with the repository.

</details>

## Documentation

- [Documentation index](packages/coding-agent/docs/index.md)
- [Usage](packages/coding-agent/docs/usage.md)
- [Turn metrics and harness evaluation](packages/coding-agent/docs/metrics.md)
- [Providers and models](packages/coding-agent/docs/providers.md)
- [Automation and SDK](packages/coding-agent/docs/sdk.md)
- [Run protocol](packages/coding-agent/docs/run-protocol.md)
- [Runtime algorithms and direction](packages/coding-agent/docs/runtime-algorithms.md)
- [Specification index](specs/README.md)
- [Sessions and recovery](packages/coding-agent/docs/sessions.md)
- [Security](packages/coding-agent/docs/security.md)
- [Containerization](packages/coding-agent/docs/containerization.md)
- [Public skill catalog](SKILLS.md)
- [Changelog](packages/coding-agent/CHANGELOG.md)
- [Release notes for v1.4.0](.github/RELEASE_NOTES_v1.4.0.md)
- Latest public release: [v1.3.1](https://github.com/dmae97/omk/releases/tag/v1.3.1). The notes linked above describe the next release until it is published.

## Development

```bash
npm ci --ignore-scripts
npm run build
npm run check
npm test
npm run release:local
```

Direct dependencies are pinned, CI installs with `--ignore-scripts`, and the
published CLI includes a generated `npm-shrinkwrap.json`. Read
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[development guide](packages/coding-agent/docs/development.md) before sending a
change.

## FAQ

### Why use OMK instead of Claude Code?

Use it for provider choice within one CLI session, or to build workflows
against its public runtime and evidence APIs. For a single-provider workflow,
your current agent may be sufficient. Try the [read-only task above](#quick-start)
before moving existing work.

### How is this different from OpenCode with plugins?

OMK is a separate runtime with its own CLI, sessions, tool scheduler, and SDK.
One reason to choose it is to build your own acceptance workflow: define
required test observations in the [run protocol](packages/coding-agent/docs/run-protocol.md),
then have your automation reject `fail` or `inconclusive` results. Receipt
integrity and freshness still need their own configured checks.

For adding a tool or prompt to an existing OpenCode setup, a plugin may be the
smaller change. OMK's protocol is opt-in, not proof of better performance.

### Does multi-agent mean better results or automatic verification?

Not automatically. Subagents require setup, and verification must be part of
the chosen workflow. Its result covers the declared checks, not all behavior. See
[what runs by default](#what-runs-by-default) and [evidence and limits](#evidence-and-limits).

## Recent releases

<details>
<summary>Release notes and historical corrections</summary>

> Historical correction: the immutable v0.97.0 notes below announced a
> versioned OpenWiki corpus, but that release still ignored `/openwiki/` and did
> not contain the corpus or checker. See the current repository-understanding
> section above for the shipped guards and optional-corpus boundary.

<!-- releases:start -->

## Release v1.4.0

### Breaking Changes

- Session write/edit tools now reject paths outside the session workspace, including symlink targets. Only global `fileTools.writeRoots` can widen the allowed roots; SDK factories keep their existing behavior unless `workspaceRoots` is passed.
- Subagent workers no longer load user extensions: the worker command line now includes `--no-extensions`. Skills, the command-safety gate and the todo checklist are unchanged, and the extension that registered the worker's model provider is still loaded automatically. To keep extensions in workers, set `OMK_WORKER_EXTENSIONS=all` or a comma-separated list of extension names (for example `OMK_WORKER_EXTENSIONS=my-mcp-adapter`).

### Fixed

- Subagent tool-result details contain plain data; process settlement promises stay with the lane owner. Shared heavy-process capacity follows the current admission decision or configured normal cap, and checkpoint briefs retain both their goals and closing criteria.
- Top-level Grok/Devin harness sessions can use their workspace and the subagent tool while preserving blocked paths and project trust. Subagent nesting defaults to one child level.
- Orchestration scope matching normalizes case, separators and traversal, conservatively checks wildcard overlaps, and rejects escaping lane and evidence paths.
- The startup header no longer repaints the whole screen and duplicates the transcript into terminal scrollback on every turn. Its RUN, VERIFY, ctx/meter and TODO rows changed on each turn after the header had scrolled off, which forced a full redraw (about 21.8 KB instead of about 150 bytes per frame) and re-emitted transcript rows into scrollback (835 duplicate rows after 8 turns in the regression test). The header now freezes on the last snapshot before the first turn starts and reuses its rendered lines; the status sidebar and the control-pane overlay (`Ctrl+O`) show the live values. Once frozen, the header no longer rebuilds its status snapshot or re-lays out each frame (about 4.5 ms → 0.01 ms per frame at 160 columns), and the overlay's per-frame snapshot reads the MCP inventory from a 5-second cache instead of from disk. When the session changes (`/new`, `/resume`, `/fork`, which clear the transcript) the header goes back to live values until the first turn. When the model or thinking level changes (`/model`, model cycling) the header re-captures its snapshot if it is on screen; once it has scrolled into scrollback it keeps its lines, so a model change adds no full redraw and no scrollback copy, and it shows the new model when it is visible again or the session changes. The footer and the status sidebar show the new model right away.
- Timers no longer outlive the rows they animate. A bash tool row's 1-second elapsed-time ticker kept running and requesting renders after the row left the screen (chat cleared or rebuilt, or the turn ended while the tool was still pending); disposing a tool row now stops it, and tools still pending at the end of a turn are disposed. The working spinner is stopped instead of detached when compaction starts, so it no longer requests a render every 80 ms behind the compaction spinner. The spinner of a running `!` command stops when the chat is cleared (`/new`, `/resume`, `/fork`) instead of ticking until the command ends; the command's completion or `Ctrl+C` still finishes the row. Measured: 5 bash rows removed while running left 5 timers and 10 renders in 2.1 s, now 0 and 0.
- The editor keeps the last 200 undo steps (was unlimited). Each step is a full copy of the draft, so a long hand-typed prompt retained memory proportional to edits × draft size: 46.6 MB for a 4000-word draft, now 4.8 MB.

### Added

- Typed todo verification (`OMK_TODO_VERIFY`, default off), with file and command checks at finish-check and privacy-preserving run logs.
- Current lane-grant isolation planning validates explicit resources, scopes and evidence paths and detects conflicting writers; it only plans paths and does not create worktrees.
- Progress-stall detector on the built-in identical-loop harness: a bounded ring buffer of recent tool calls, near-duplicate bash signatures (whitespace / number / quote / path-tail normalized, token-set Jaccard), and a no-progress signal (no successful edit/write in the last K calls, or repeated identical error outputs). Exact consecutive identical args still warn at 3 and block at 6; near-duplicates only steer (rate-limited), with a low remaining-budget message when an injected `remainingBudgetFraction` reports under 20%. Near-dup steers honor `setProgressStallSteerSuppressed` so a finish-check verification turn can silence them. Thresholds calibrated on R7 omk trial trajectories (window 32, similarity 0.65, need 6, no-progress 12, steer every 12).
- Experimental `OMK_ADAPTIVE_EFFORT=1` (default off; only exactly `1` turns it on) varies reasoning effort by work phase. Calls that plan, debug a repeated failure or verify keep the configured effort; explore, edit, build and run calls send `high` instead (or the configured effort if it is lower, or the next level the model supports below it), so grok-4.7 at `xhigh` sends `high` for most tool calls. The phase comes from the active typed todo (read independently of `OMK_TODO_VERIFY`) and the last tool calls (bash commands are classified by rule) and switches only after two calls in a row, at most four times per session. The model, system prompt and tool list never change. Summary calls and subagent workers are not affected. With `OMK_RUN_LOG_DIR` set, `llm-call.jsonl` lines also carry `phase`, `phaseSource`, `effortGroup`, `effortSwitch` and `lowerClamped`. Off, nothing new is loaded and requests are unchanged. Its effect on pass rate and cost is not measured yet.
- Experimental `OMK_SKILL_SEARCH=1` (default off) for sessions with more than 24 model-invocable skills and the `read` tool: the system prompt replaces the skill list with one fixed line, a fixed `skill_search` tool ranks skills by name and description (BM25), and up to three new candidates arrive as a hidden message at each task start. The index is built on first use, never at startup, and cached in `cache/skill-index-v1.json` under the agent directory. Subagent workers keep the tool without automatic candidates. With `OMK_RUN_LOG_DIR`, `skill-select.jsonl` gets hash-only records. If another tool is already named `skill_search`, the session stays as without the flag. Off, or with 24 skills or fewer, requests are unchanged. See [skills](packages/coding-agent/docs/skills.md#skill-search-omk_skill_search).
- Experimental `OMK_SKILL_SELECT=bm25|metacon` (default unset, off) picks how skill search ranks: `bm25` as above, or `metacon`, which narrows to the BM25 top 64 and picks a set of skills covering the query words with local capability-coverage planning, then fills the remaining slots in BM25 order. No model or network call. Skills with byte-identical SKILL.md content appear once. Any other value, including `wpl`, stays off with one warning. `OMK_SKILL_SEARCH=1` stays as an alias of `bm25`. See [skills](packages/coding-agent/docs/skills.md#ranking-mode-omk_skill_select).
- `llm-call.jsonl` run log, diagnostic only: with `OMK_RUN_LOG_DIR` set, every provider request appends one line with the provider, model id, the requested reasoning effort and the value actually sent to the provider (grok-4.7 `max` goes out as `xhigh`), input/output/cache-read/cache-write tokens, omk's cost estimate, stop reason, request start time, provider response id, duration, the gap since the previous call ended, the message count and sha256 hashes of the system prompt and tool list. Aborted and failed calls get a line too; when no usage arrived (for example a reasoning-cap abort), token and cost fields are `null` with `usageMissing: true` rather than 0. OMK's catalog cost estimate includes xAI reasoning tokens; provider-reported billed cost is separate. Lines hold numbers, ids, hashes and enum names only. Off unless `OMK_RUN_LOG_DIR` is set; unset, nothing is wrapped, hashed or written, and request bytes are unchanged either way.

### Changed

- Control-panel and sidebar section rules use the strong border token consistently.
- Pin shell-quote to its security-fixed 1.11.0 release. The unresolved node-forge advisory remains a release blocker.
- Long transcripts render faster: `visibleWidth` in `omk-tui` measures styled ASCII, Hangul and CJK text without grapheme segmentation, and its width cache holds 8192 entries (was 512, which missed on every line of a long frame). Measured on 24k rendered lines: styled ASCII 604 ms → 19 ms, styled Korean about 607–764 ms → 25 ms; the first frame after a resize at 25k lines 357–411 ms → 142–148 ms; a streaming 1200-line code block 105 ms → 6.6 ms per frame. Streaming a 64 KB markdown reply is unchanged (about 13–15 ms per frame; markdown parsing dominates). A property test checks the fast paths against grapheme segmentation on styled ASCII, Hangul, CJK, emoji and wide characters.
- Tool-output boxes compare raw child output before rebuilding padding, while preserving render-generation invalidation and off-screen cache release.
- `!` / `!!` shell commands with long output no longer slow down as they print. The output block re-joined and re-truncated the whole output on every chunk, so the cost per 1 KB chunk grew from 0.9 ms at 0.9 MB to 21.8 ms at 13.8 MB; it now works from a bounded tail of the most recent 100 K characters and stays at about 0.3 ms. The displayed lines, hidden-line count and truncation notice are unchanged (a property test checks the tail against the full output), and `getOutput()` still returns the full output.
- `llm-call.jsonl`: `effort` and `effortSent` are now read after the run's model contract is applied, from the same model and options the provider is called with. A request the contract refuses is no longer logged, since it never reaches the provider.
- Package install scripts are off by default. `omk install`, `omk update`, git package dependencies, missing project packages installed at startup and `-e` packages now install with `--ignore-scripts`, because a package's `preinstall`/`install`/`postinstall` runs arbitrary code with your privileges. `omk install --allow-scripts <source>` and `omk update --allow-scripts` run them for that command; an install failure or an extension load failure that looks like a skipped native build names that option. Packages that build native code in an install script need it. See [Install scripts](packages/coding-agent/docs/packages.md#install-scripts).
- A cloned project's code loads only after you trust the project. Its `.omk/settings.json` `packages` and `extensions`, files in `.omk/extensions/`, and its `npmCommand`, `shellPath` and `shellCommandPrefix` used to load or run on the first `omk` in that directory, including installing missing packages. Interactive `omk` now asks once per project and stores the answer in `~/.omk/project-trust.json`, tied to a hash of those settings, the file paths under `.omk/extensions/` and the `package.json` manifests there; a changed hash asks again. `-p`, json, rpc, workers and the package commands never ask: they follow a stored answer for the same path and hash, or `OMK_TRUST_PROJECT=1`, which prints one stderr line naming the project. `OMK_TRUST_PROJECT=1` applies only to non-interactive runs and only to the directory omk started in; omk removes it from its environment at startup so the `bash` tool and other child processes do not inherit it, and interactive `omk` ignores it and asks. `OMK_TRUST_PROJECT=0` keeps project code off even after trusting. Workers get `OMK_TRUST_PROJECT=1` from the subagent extension only when the parent trusted its project, the worker's directory is inside it or in a git worktree registered by the project's repository (when the project is that repository's top level), and it hashes the same. The worktree check needs git 2.36 or newer (older git gives workers outside the project no trust), and only positive git answers are cached, so a worktree added later or a git that failed once is checked again on the next spawn. For extension authors: `workerProjectTrustEnv()` now returns a Promise; `await` it. Untrusted projects keep their skills, prompts, themes and other settings. See [Project trust](packages/coding-agent/docs/packages.md#project-trust).
- Developers of this repository: `.omk/extensions/` here (`powershell-compat`, `cli-anything`, `telegram-notify` and others) no longer loads in an untrusted checkout. Run `omk` interactively once in your checkout and choose Trust (later `-p` runs and workers follow that answer), or set `OMK_TRUST_PROJECT=1` for headless runs and CI (interactive `omk` ignores it). Workers in a git worktree of a trusted checkout follow the parent; a fresh worktree opened directly needs its own answer.
- The skill choice of a session's first prompt (provider harness picks, `!skill:` selections, context-budget ranking) is kept in the system prompt for the session; a later prompt's different choice is sent as a hidden `<prompt_skills>` message after the user message, so the provider's prompt cache keeps its prefix. A single `-p` request is unchanged.
- The skill catalog cache now also covers the one-`SKILL.md`-per-skill paths that auto-discovery produces, so a start no longer reads, parses and hashes every `SKILL.md` again. Each file is checked with one `stat` (size, mtime, ctime, inode); an edited, removed or added skill is picked up on the next start. File entries are capped at 4,096 separately from the 64 directory entries, least recently used first out. The loaded skills and the request are unchanged.
- The interactive chat no longer slows down as a session grows. `ChatContainer` freezes finished messages above the viewport and re-renders a frozen message only when it changes, for example a tool card expanded with `Ctrl+O` or a late tool result. On a 20k-line transcript of real message and tool components, a keypress frame drops from ~40 ms to ~1.7 ms mean (p95 ~52 ms → ~2 ms), and process RSS no longer climbs by ~180 MB during the first streaming response.
- Whether a message is finished follows agent events, not message data: an assistant message is live from `message_start` to its `message_end`, a tool until its final result, and `agent_end` closes anything still open (a provider that throws mid-stream leaves its partial message without a `message_end`).
- A headless `-p --mode json` worker (the subagent command line) loads 131 fewer modules at startup, 1,644 files instead of 1,775. The subcommand handlers (`doctor`, `stats`, `provider adopt|sync|doctor`, `sdk session`, `router-feedback`, `run`), the verified-run coordinator, `omk-adaptorch-wpl`, ACP mode, `omk quota`, `omk neo`, the `--resume` picker's loaders and HTML export now load only on the path that uses them. Commands behave as before.
- The control panel no longer runs a synchronous process (the headroom version check) while it draws. The check (`headroom --version`, `headroom version`, then the `headroom` and `headroom-ai` Python packages) now runs once in the background, the label updates when it answers, and quitting stops a check that is still running. Where headroom is installed, the label shows the policy id until the check answers.

Release notes live in [RELEASE_NOTES_v1.4.0.md](.github/RELEASE_NOTES_v1.4.0.md).

## Release v1.3.2

### Added

- `omk doctor [--json] [--online]` checks the runtime, the agent directory, credentials, the model a first session would pick, the bash sandbox, `fd` and `rg`, and network reachability, and prints the fix for this machine. The checks run as a dependency graph with deadlines, so a root cause is reported once. The exit code is 0 when no check fails, 1 when one does and 2 for a usage error. `doctor` connects to nothing without `--online`, writes neither the agent directory nor `models.json` snapshots, and does not refresh an expired OAuth token. Previously `omk doctor` was sent to the model as a prompt.
- A first run with no model configured opens the `/login` selector before the first prompt instead of failing that prompt (`Esc` skips it). When a Claude Code or Codex CLI login already exists on the machine, it names the `omk provider adopt <provider>` command that reuses it.
- Standalone installer: `curl -fsSL https://github.com/dmae97/omk/releases/latest/download/install.sh | sh`, attached to GitHub Releases from this release on. It downloads `omk-<os>-<arch>.tar.gz` and checks it against the release's `SHA256SUMS`, which it always takes from GitHub over HTTPS, also when `--base-url` names a download mirror (`--trust-mirror` takes the mirror's file instead, with a warning). It needs `curl`, resolves `latest` once, installs into `~/.omk/versions/<version>` and points `~/.omk/bin/omk` at it with an atomic rename. It never replaces an installed version directory: reinstalling the same archive does nothing, and another build of an installed version gets its own directory. `--allow-unverified` applies only when the release has no `SHA256SUMS` (HTTP 404); any other checksum failure stops the install. See [quickstart](packages/coding-agent/docs/quickstart.md).
- Release builds attach `SHA256SUMS` and a signed build-provenance attestation that covers the binaries and `install.sh` (`gh attestation verify omk-linux-x64.tar.gz -R dmae97/omk`). The attestation runs in its own job, the only one that can mint an OIDC token, and the GitHub Release waits for it.
- Opt-in RTK output filter for the built-in `bash` tool. With `OMK_RTK_OUTPUT=1` and `rtk` from `OMK_RTK_PATH` or `PATH`, successful output of 1 KiB or more from plain `vitest run` and `tsc --noEmit`/`tsgo --noEmit` commands is summarized with `rtk pipe`. The full output is kept in an owner-only file named in the result, and any filter problem returns the original output. Off by default; RTK is not bundled. See [RTK output filter](packages/coding-agent/docs/rtk-and-mutation-testing.md).
- `omk run explain ID [--state-dir DIR] [--json]` and SDK `RunCoordinator.explain(id)` explain a verified run from one ledger snapshot: DAG dependencies and unfinished ancestors, candidate and receipt bindings, and claim closure. They are read-only and start, retry or approve nothing. See [verified run](packages/coding-agent/docs/verified-run.md).

### Changed

- `omk --version` and `-v` print the version without loading the runtime. On the measurement VM the Node CLI went from 635 ms to 62 ms (1,498 to 19 loaded modules) and the standalone binary from 554 ms to 385 ms.
- With no default model configured, credentials are ranked: stored login, then a provider API key, then ambient cloud credentials. With AWS credentials in the environment and `ANTHROPIC_API_KEY` set, a first session now uses Anthropic instead of Amazon Bedrock, whose first request failed with a token error. When only ambient credentials exist, OMK names the variable that selected the provider. A configured default model is unchanged.
- The bash sandbox counts as available only when `bwrap` actually runs a command, not from static checks. Hosts that block unprivileged user namespaces, setuid `bwrap` with `user.max_user_namespaces=0` included, now get setup steps for that host (package, AppArmor or container) instead of a raw `bwrap` error at the first command. See [Bash sandbox setup](packages/coding-agent/docs/sandbox-setup.md).
- `fd` and `rg` are downloaded after the first frame instead of before it. Behind a stalled network the first frame took about 11 s and now takes about 1.2 s; offline startup is unchanged. Startup, `grep` and `find` share one download per tool.

### Fixed

- `omk run cancel` and `omk run explain` on a running verified run no longer fail with `verified-run: integrity` when the run's writer appends to its journal at the same moment. Journal reads now retry that one case up to 3 times; real journal corruption still fails at once (spec 056).
- Extension messages sent with `triggerTurn`, background-task notifications among them, are delivered once, after the work that kept the session busy and on the resulting context: automatic or manual (`/compact`) compaction, a branch summary, a retry's model switch, prompt preflight, the resource check before a run, or a tool that settles after its run ended. Previously they failed with `PromptExecutionBusyError` and no follow-up turn ran, or, after a manual `/compact`, were answered from the context before compaction without being stored.
- Follow-up input (`sendUserMessage(text, { deliverAs: "followUp" })`, or a prompt with `streamingBehavior`) that arrives while another prompt is still in preflight, its pre-prompt compaction included, runs with that prompt's run; if that prompt fails, the input runs on its own once the session is idle. Registered extension commands run at once in that window. Other slash text is still refused while the session is busy.
- Text typed in the interactive TUI during compaction is sent when compaction ends: as a follow-up of the run that resumes, or as a new prompt. Previously the send failed and the text went back to the editor queue.
- Clearing queued messages (`Esc`) also clears turn input that was waiting for the session to become idle.
- A prompt whose run ended while extension input handlers were still processing it now runs in a new run budget instead of being refused.
- Model requests no longer keep about 1.1 KB per request alive for the life of the process. Abort signals are linked with `linkAbortSignals()` instead of Node 22's `AbortSignal.any()`, and `npm run check:abort-signal-any` keeps new `AbortSignal.any()` calls out of the source.

Release notes live in [RELEASE_NOTES_v1.3.2.md](.github/RELEASE_NOTES_v1.3.2.md).

## Release v1.3.1

> Published 2026-10-08: tag `v1.3.1` (`a989d88`), GitHub Release and npm `latest` for all seven packages, built from that commit. The entries below, except the first Changed entry, were still listed under `[Unreleased]` when 1.3.1 was tagged; the 1.3.1 packages contain them. See also the [1.3.1 preparation notes](.github/RELEASE_NOTES_v1.3.1.md), written before publication.

### Added

- Offline source-quote memory factorial CLI: isolated prior-session stores, paired independent/dependent tasks and explicit memory-off/on controls. The default report has 1,200 deterministic mechanism evaluations, not live LLM efficacy or KV measurements. See [offline experiment](packages/coding-agent/docs/memory-factorial-experiment.md).
- `/session` reports the last request's memory state and eligible/omitted counts without reading source quotes, enabling recall or changing the VERIFY verdict. See [memory recall hardening](packages/coding-agent/docs/memory-recall-hardening.md).
- Logical request admission has an `observe` default and explicit `OMK_REQUEST_ADMISSION_MODE=enforce` or `off` controls, with bounded JSON projection before logical dispatch. It is not provider-wire or billing accounting. See [request admission](packages/coding-agent/docs/phase5-runtime-boundaries.md).
- Optional `OMK_MEMORY_SELECTION=v2` uses lexical query coverage and complete-span redundancy suppression, prices the actual synthetic tool pair and checks the full context. Legacy selection remains the default. Source snapshots are shared only within one recall, with freshness, expiry and revocation rechecked. See [recall selection](packages/coding-agent/docs/phase5-runtime-boundaries.md).
- Built-in themes `omk-paper-dark` and `omk-paper-light` (aliases `paper`, `paper-dark`, `paper-light`, `omk-paper`) in the README hero's palette: ink text, secondary and tertiary ink, one vermillion accent, and subdued info, teal, green and ochre for links, code and syntax. Every text role measures 4.5:1 or more and every boundary 3:1 or more against the paper surfaces and common terminal backgrounds, `#1e1e1e` included; three dark values are one step lighter than the web palette to get there. Both carry HTML-export paper surfaces.

### Changed

- All seven public workspace packages and their internal dependency ranges are aligned to 1.3.1. External dependency versions are unchanged.
- Assistant message content views call `setText` only when a block’s source text changes, so finished Markdown instances and their render caches stay reused across streaming updates. Markdown/Text `setText` still no-ops when the displayed string is unchanged.
- Slash-command autocomplete (`SelectList`) caches the primary column width while the filter is unchanged, so `/` with large skill lists does less work per frame.
- CLI no longer loads `undici` at process start. A fetch hook installs the global dispatcher on the first `fetch` (one common choke point for providers, OAuth and tools). `scheduleHttpDispatcher` remembers the idle timeout from settings without importing undici until then.
- HTTP idle-timeout helpers (`parseHttpIdleTimeoutMs`, defaults, UI choices) live in `http-idle-timeout.ts` so `settings-manager` no longer pulls `undici` into the AgentSession import graph. `configureHttpDispatcher` still loads undici when the CLI or session actually configures the dispatcher.
- The control rail (the startup deck column and the control-pane overlay in expanded view, `Ctrl+O`) now shows RUN, VERIFY, CONTEXT and RESOURCES, then TODO and SESSION. RUN has the turn state; VERIFY has one `verdict` row; CONTEXT has `model`, `think`, `ctx`, `meter` and `opt` (formerly `headroom`); RESOURCES has the governor mode (`gov`) and configured MCP/skill counts (`ext`, formerly `res`).
- The control-pane overlay is anchored to the viewport and adds the live rows: RUN `queue` (queued message count), RESOURCES `cpu` (host CPU, the value the resource governor admits on; `busy` at or above its busy threshold) and `rss` (OMK process RSS), and, when a turn ends without completing, a failure card from the session termination record: cause, phase, side effects, retry policy (`auto`, `manual` or `none`) and next action. The startup deck column omits them: the startup header scrolls into terminal scrollback, where any later change re-emits up to four screens, so it keeps a fixed height and shows only turn-stable values.
- The pinned status sidebar shows `run` and `vrfy` rows, plus the cause, retry policy, side effects and next action of a turn that ended without completing. Its MCP roster lists up to terminal rows − 26 servers (was − 24), so these rows take their height from the roster instead of pushing the bottom border and unpin hint off screen.
- Status values pair a glyph with text: `✓` ok, `●` active, `!` blocked, `▲` degraded, `?` unknown, `~` stale, `◐` inconclusive. A value without a source shows as unknown (`?`), never as healthy.
- The startup opening uses the paper/ink/vermillion design language of the README hero: a `FIG. 01 · THE CONTROL LOOP` plate, OMK's control-loop mark beside a serif half-block `OMK` wordmark, the tracked `OPEN MULTI-AGENT KIT` subtitle, an accent rule, the hero's lede (`Scope the work. Route the right agents. Verify every release.`), the `SCOPE → ROUTE → VERIFY → REPLAY` flow and a `MODEL … · THEME … · ANSI …` row. RUN, VERIFY and CTX appear only in the rail beside it. Below 120 columns the opening is a closed plate with `OMK · OPEN MULTI-AGENT KIT`, the lede, the status line `OMK vX · VERIFY … · MODEL … · ANSI ON|OFF` and the key hints (was `WELCOME TO OMK` and `OMK vX | VERIFY … | MODEL … | ANSI:…`); the expanded view adds the wordmark block and `THEME` once. The panel lines under the deck are left-aligned.
- VERIFY reads `? unverified` in interactive sessions. No evidence workflow is attached to the interactive session, so a settled prompt or a completed turn does not change it.
- Context pressure in the control rail, the pinned sidebar and the footer uses one threshold pair: elevated (warning color) from 70%, critical (error color) from 90%. Previously the rail and sidebar meters changed color at 65% and 85%, the sidebar `ctx` figure and the footer's context figure above 70% and 90%, and the rail `ctx` row was green at any usage.
- Percentages in the control rail and the pinned sidebar, and the footer's context figure, are floored at display precision: 69.96% shows 69.9%, not 70.0%, so a figure never reaches a color band before its color changes.
- Rail visibility comes from one layout classifier: XS below 80 columns, SM 80–119, MD 120–159, LG 160 and wider. Rails render only at MD or LG. The startup deck needs 120 columns (was 113), and the control-pane overlay needs 120 columns and 16 rows (was 112 and 12). These numbers may change after visual QA in native terminals.
- The pinned status sidebar (`pinStatusSidebar`, `Ctrl+Q`) now needs at least 120 columns (was 96) and 16 rows; on smaller terminals the bottom status bar stays, and pinning with `Ctrl+Q` shows `Status sidebar pinned; it shows at 120+ columns and 16+ rows.`
- When no theme is set, omk uses the new paper pair: `omk-paper-dark` on dark terminals, `omk-paper-light` on light ones (was `omk-control-panel` / `omk-control-light`). An explicit `theme` setting is unchanged; `omk-control-grid-dark` and the other built-in themes stay selectable.
- The accent now marks only the Verify stage, the active tab and live signals. Frame titles, section labels, the rail identity, git branch, uptime, model id, token counts, usage labels, the activity sparkline, the theme name and the startup resource list's group labels use ink or secondary ink instead. Control-panel and status-sidebar frames use square hairline corners, and the single-column layouts use captioned plate rules (`┌─ LABEL ─┐`, `├─ LABEL ─┤`, `└─┘`).
- Opening the expanded view (`Ctrl+O`) inks the wordmark in once: 420 ms, ease-out, from a faint pencil underdrawing to ink, with the Verify accent last. It changes colour only, never the layout, and is skipped for reduced motion, `NO_COLOR`, non-TTY output and narrow widths.

### Fixed

- Closed source-quote memory wrappers release their controller/store references and skip closed predecessors. Already-aborted requests refuse before starting predecessor work, and closed controllers refuse new mutations.
- Durable file locks are staged with their owner record and atomically renamed into place, so a crash cannot leave a newly acquired ownerless lock. Existing lock ownership and identity checks remain.
- Goal acceptance excludes OMK-owned goal, metrics and run state from workspace freshness, so OMK's own bookkeeping no longer invalidates a passing check; task-file changes still do. Completion rejections are surfaced instead of leaving a goal silently active.
- Verified-run cancellation and owner exit kill the owned sandbox process group, including namespace setup before `--die-with-parent` is armed. Reaped empty groups are removed to avoid signaling a reused group number; signal delivery is not termination evidence.
- Local session control enforces a total monotonic connection deadline, reclaims stale endpoints under its existing authorization checks and admits aborts independently of the prompt-command cap. Prompt generations can bind an abort to the intended request; acceptance does not prove termination. See [control deadlines](packages/coding-agent/docs/phase5-runtime-boundaries.md).
- Skill lists with more than 24 visible entries use bounded descriptions that preserve both the lead and usage trigger, with abbreviation-aware sentence boundaries.
- Headless runs defer interactive-mode, theme, syntax-highlighter and built-in tool-renderer imports until used. Explicit extension theme access still initializes the theme; session disposal removes highlighter-ready listeners.
- Per-request static prompt/tool token counting reuses only the two immutable texts, while full message and envelope pricing remains exact. Source/record reads allocate their statted size plus one rather than maximum-size buffers; V2 skips token pricing for nonmatching records without caching validity or relaxing expiry/revocation checks.
- The empty part of the context and usage meters (`░`) is visible again on dark themes. It was painted with `borderMuted`, which several themes set within a shade of the background (`omk-paper-dark` `#43413d`, `catppuccin-mocha` `#181825`, `omk-aurora-dark` `#161B27`), and `░` only fills part of the cell, so the track disappeared. The rail, header and sidebar meters now share one `meterBar` helper that paints the track with `dim`.
- An extension that replaces `globalThis.fetch` keeps seeing every request again. Since undici began loading on the first `fetch`, that first request's install compared against the extension's hook instead of omk's own and replaced it with undici's `fetch`, so the hook ran only once per process. omk now sets the undici dispatcher and leaves an extension's `fetch` in place, as before the lazy load; without an extension, `globalThis.fetch` still becomes undici's `fetch`.
- `omk -p` now arms an unref'd exit guard after print mode finishes: when a stray handle keeps the event loop alive past 2s (override with `OMK_PRINT_EXIT_GRACE_MS`, `0` disables), it writes the held resource kinds to stderr and exits with the run's code. Normal runs are unchanged because the timer is unref'd.
- The interactive footer metrics timer no longer requests a full TUI re-render every 2 seconds when system CPU/MEM metrics are disabled (the default). The footer now owns the interval and only runs it while metrics are shown, so toggling metrics starts and stops the timer instead of waking the event loop every 2 seconds. `footer.invalidate()` was already a no-op, so those ticks only burned render cost proportional to chat history length.
- `omk -p "- …"` no longer exits with `Unknown option` when the inline prompt starts with a dash and contains whitespace or a newline. One-word dash tokens after `-p` still error; `omk -p -- -foo` passes them as text (spec 028).
- Processes that import `AgentSession`, every `omk -p` worker included, no longer load jiti and its bundled Babel (about 1.5 MB of CommonJS) at startup. The extension loader imports `jiti/static` when it loads its first extension file, so a run without extension files never loads it. Importing `core/agent-session.js` alone now takes about 15 MB less RSS and 8 MB less heap after GC.
- Session-input and request-context admission no longer allocate one temporary string per transcript character when estimating tokens. `estimateTextTokens` walks UTF-16 code units with `charCodeAt` and an inlined Unicode whitespace table instead of `for...of` plus `/\s/u`, so long headless sessions keep the same token counts while cutting per-turn garbage that was pushing RSS up with history length.
- `boundedAdmissionJson` returns a flat concatenated string (`joinWrapped`) instead of wrapping `parts.join(",")` in a template literal, so the token counter does not flatten a second full-transcript copy of the admission projection on every provider request.
- Token counter adapters may implement optional `countTextParts(parts, modelId)`, which returns the same result as `countText(parts.join(""), modelId)` without building the joined text. The fallback estimator (`estimateTextTokensFromParts`, now in `text-token-estimate.ts`) and the token counter registry implement it; `countTextParts(counter, parts, modelId)` joins for adapters that do not.
- Session-input admission (`estimateContextInputTokens`) and request-context admission count the transcript JSON as per-message pieces instead of first building one transcript-sized string. `canonicalizeMessagesForContextAdmission` now returns `textParts`, and `projectRequestForAdmission` returns `messageParts` (from the new `boundedAdmissionJsonParts`); joined, each is byte-identical to the previous text, and token counts, budget charges and errors are unchanged.
- `ExtensionRunner.emitContext` returns a shallow copy instead of a `structuredClone` of the whole history when no extension registers a `context` handler. When any handler is registered the deep clone and handler semantics are unchanged. Default sessions always load the built-in `tool-pair-repair` context handler; see the next entry for how that case avoids the clone.
- `on("context", handler, options?)` accepts optional `{ mutatesMessages: false }`. When every registered context handler opts in (or none exist), `emitContext` shares a shallow `[...messages]` array instead of `structuredClone`. Default / unmarked handlers keep today's deep clone. The built-in `tool-pair-repair` handler is marked non-mutating; it already builds new arrays via filter/spread and never writes into `event.messages`.
- The startup panel no longer shows fixed status values as live state. The control rail, the hero strip and the narrow status line printed `ready`, `active`, `tracking`, `linked`, `pinned` and `DAG:omk-parallel-orchestrator` with no runtime source, most of them in the success color. Status rows now come from one `ControlPlaneViewModel` built from the live session by one adapter, `readControlPlaneSignals`; the pinned status sidebar builds the same view model through the same adapter.
- Status rows in the control rail and the pinned sidebar, and the startup header's MODEL and THEME values, print session, run-journal, model, theme and file-system text (model id, theme name, cwd, git branch, session name, endpoint host, MCP server names, TODO labels, failure text) as one printable line: escape sequences, control characters and bidi marks are removed and line breaks become spaces. In 1.2.4 the rail's model, cwd, git and TODO rows and the pinned sidebar's cwd, git, session and model rows printed such text as-is; sidebar MCP names were already cleaned.

### Removed

- From the control rail: the STATUS and CONTROL sections, the `omk` and `sidebar` rows, the `pulse` sparkline (seeded from a hash of the status snapshot, not measured), the `MATRIX RAIN // NEON GRID ONLINE` line and the `pkg` package-intake row. Package intake still appears in the footer and in the pinned sidebar's SYSTEM section. The `CYBERPUNK OPS CORE` and `NIGHT-CITY-MATRIX-V3` lines are gone from both the rail and the hero.
- The startup banner's hue gradient, scramble reveal, idle colour drift and sparkle starfield. `OMK_CONTROL_IDLE_DRIFT` no longer has an effect: the opening never loops.

Release notes live in [RELEASE_NOTES_v1.3.1.md](.github/RELEASE_NOTES_v1.3.1.md).

<!-- releases:end -->

</details>

## Acknowledgments

OMK builds on [pi](https://github.com/badlogic/pi-mono) — Mario Zechner's
MIT-licensed coding-agent harness — and began from the
[oh-my-pi](https://github.com/can1357/oh-my-pi) fork. The vendored tree was
removed in this release line; OMK `0.9x` is OMK-native (see
[`specs/constitution.md`](specs/constitution.md)), and the design debt to both
projects stands. Thank you.

## License

MIT
