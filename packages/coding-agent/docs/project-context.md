# Project Context

OMK owns a small repository index, not another source of project truth. Source code, Git,
AGENTS instructions, specs, ADRs and mission files remain authoritative. Spec Kitty's
bootstrap/compact disclosure and continuation pointers inform this design; its governance
state machine is not imported.

## Concepts

| Concept | Responsibility |
| --- | --- |
| Project Context Bootstrap | Discover project coordinates for the first time |
| Project Context Index / Project Map | Persist bounded module, state and source pointers |
| Compact Context | Render the small, budgeted payload the agent receives |
| Context Refresh | Update changed metadata contributions from Git and file fingerprints |
| Context Expansion | Read only a requested section, module or admitted source |

The pipeline is `repository -> bootstrap -> index -> compact context -> agent -> selective expansion`.
It makes no model or network calls and does not generate a repository-wide prose summary.

## Commands

Run from the repository or use `--root`:

```bash
omk context bootstrap --budget 2000
omk context status --json
omk context refresh
omk context show
omk context show --section state
omk context show --module open-multi-agent-kit
omk context show --file AGENTS.md --budget 512
omk context verify --json
```

The source checkout can use its existing source runner instead of rebuilding:

```bash
node node_modules/tsx/dist/cli.mjs --tsconfig tsconfig.json \
  packages/coding-agent/src/cli.ts context bootstrap
```

- `bootstrap` creates a missing index and refuses to replace an existing one.
- `refresh` preserves the selected budget unless `--budget` overrides it. It updates the
  index, not source files, Git history, mission state or project instructions.
- `status` reports `missing`, `fresh`, `stale` or `invalid`. A status query exits `0`;
  inspect its status field rather than interpreting exit `0` as freshness.
- `verify` checks source hashes, companion artifact generations/digests, the incremental
  cache and current inventory. It exits `1` unless the admitted index is fresh.
- `show` emits compact context. `--section modules|state|pointers`, `--module`, and
  `--file` are mutually exclusive expansion selectors. JSON output includes the text,
  estimated token count, budget and omitted row count. Expansion selectors belong only
  to `show`; an unknown argument or invalid budget exits `2`.

## Artifacts

All generated data stays under `.omk/context/`:

| File | Contents |
| --- | --- |
| `project.yaml` | Project identity, budget, source pointers, refresh counters, companion digests |
| `modules.yaml` | Module roots, manifest references, entrypoints and declared local dependencies |
| `state.yaml` | Observed Git state, mission/checklist observations, constraints, ADR/handoff pointers |
| `snapshot.json` | Incremental file inventory and metadata contributions; never injected into prompts |

Paths inside records are relative to the repository. The workspace binding is a hash of
its canonical root: copied artifacts are not trusted in a different checkout. Regenerate
there instead. These are derived local artifacts, not portable governance documents;
ignore `.omk/context/` in project version control if it is not already covered. The CLI
does not alter your ignore files.

Records share a generation. Atomic file replacement and a durable mutation lock serialize
writers; the project record is the last commit marker. Mixed generations or interrupted
writes are refused, not silently accepted. A corrupt cache or record is not automatically
overwritten by refresh. Inspect it and explicitly remove the generated artifacts before
bootstrapping again. Hashes are unsigned integrity bindings, not attestation or authority.

## Discovery and incremental refresh

Discovery reads bounded metadata, not all source code: package manifests, AGENTS/CLAUDE,
README/architecture/conventions, specs/state/tasks, `kitty-specs` mission files, ADRs and
handoffs. Known ignored state files (`.kittify/config.yaml`, `specs/state.yaml`,
`specs/execution-status.yaml`) are still considered. Spec Kitty is optional.

Package manifests identify module boundaries and declared local dependency edges. npm
entrypoint fields are used, with checked `dist/*.js -> src/*.ts` and conventional source
entrypoint candidates. Cargo, Go and Python manifests provide basic name/entrypoint
coordinates, not a full dependency resolver. Without manifests, directory boundaries
provide an explicitly tree-derived map. A monorepo uses the Git root, and nested module
sessions discover the enclosing index without creating another one.

Refresh lists Git-tracked and non-ignored untracked filenames, compares HEAD changes with
Git diff, and re-extracts only metadata sources whose file fingerprints changed. Unchanged
contributions are reused. Local dependencies and entrypoints are reconciled against the
new inventory even when their manifest did not change. `refresh.read` and `refresh.reused`
report metadata source work, not total filesystem/Git I/O.

Mission/checklist fields describe the source artifact's declared state, never proven task
completion. Multiple missions remain multiple observations; OMK does not guess which is
active. Read the state/handoff pointer to continue. Constraint excerpts retain path/line;
ADR and handoff contents stay behind pointers.

## Session loading and progressive disclosure

After bootstrap, normal context discovery loads a compact `<project_index_evidence>`
payload. It is advisory evidence, not `<project_instructions>`. It does not replace or
weaken AGENTS precedence. Provider selection does not change index authority; Claude's
existing AGENTS opt-out does not remove index evidence. `--no-context-files` still disables
both. A custom SDK resource loader owns what it supplies.

No index means no bootstrap scan, write or payload at startup. Loading an existing index
reads the three bounded YAML artifacts, checks source file fingerprints and read-only Git
state; it does not parse the snapshot cache or re-read document bodies. After an explicit
refresh in an already-running session, use `/reload` to load the new payload. Stored
conversation text is not rewritten.

Compact output interleaves map, state and pointer rows. The default budget is **2,000
estimated tokens**, configurable from **128 to 6,000**. The existing OMK token estimator
handles non-ASCII text. Omitted content is counted and expansion commands are retained.
This is a provider-neutral estimate, not an exact tokenizer/usage claim. The ordinary
prompt budget pipeline may further reduce this evidence when the session has less room.
A universal 1–3 KB artifact or payload size is not guaranteed; the cap applies to rendered
estimated tokens and the index's fixed record limits.

Stale output withholds module, mission and constraint observations and shows unverified
source pointers instead. Module/state expansion refuses stale records; file expansion
can read an admitted current source and labels its relationship to the stale index.
Use `read` with line limits for detail beyond an expansion budget. Secret/binary/oversized
files, path traversal, symlinks and unsupported filesystem targets are refused; any source
extraction omission is counted explicitly. Source excerpts are forcibly redacted and
remain untrusted data.

## Limits and verification scope

- 50,000 inventory paths, 256 metadata sources/modules, 64 active Git files and constraint
  excerpts; each metadata source is at most 128 KiB. Each YAML read is capped at 512 KiB;
  the incremental cache and writes are capped at 8 MiB. Unsupported/capacity-limited
  sources appear in omission counts, not silently complete coverage.
- Git-free discovery is a bounded tree walk (24 levels, 100,000 directory entries).
  Startup checks indexed-source fingerprints only. Use `verify` to detect new/deleted
  tree structure; the status includes this limitation.
- Same dirty file edited repeatedly invalidates its inode/size/mtime/ctime fingerprint.
  Branch/HEAD changes also invalidate state. `verify` additionally hashes source bytes.
- No automatic task selection, cross-language import graph, semantic architecture
  inference, automatic refresh watcher, or session transcript summarization is provided.
- Concurrent same-user directory mutation is not a filesystem sandbox. Public output
  should still be reviewed before publication, particularly file names and excerpts.

The focused tests cover CLI operation without credentials, monorepos, source reuse,
rename/delete/new-entrypoint handling, stale state, non-Git verification, corrupt cache,
symlink boundaries, smallest budgets, provider-neutral evidence and context opt-out.
