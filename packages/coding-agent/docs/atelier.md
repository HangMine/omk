# Atelier integration

The OMK checkout includes an adapted [Pi Atelier](https://github.com/michaelmjhhhh/pi-atelier) 0.15.0 extension at `.omk/extensions/atelier`. It provides a responsive status rail, framed composer, live activity and TODO sidebar, display presets, model/tool controls, and local child-usage graphs.

The checkout discovers its `index.ts` on startup or `/reload`. This does not replace the installed engine or install a global package. To use the reviewed package from another project, explicitly install its absolute directory with `omk install /absolute/path/to/omk/.omk/extensions/atelier`.

## Commands

- `/atelier` or F6: control center.
- `/atelier display`: display ordering, visibility, presets, preview, Undo, Revert, Save.
- `Ctrl+Q` or `/atelier sidebar`: toggle the Atelier sidebar, not OMK or the tmux session.
- `/atelier sidebar auto|manual|on|off`: layout mode and visibility.
- `/atelier sidebar tools`: expand/collapse tool names.
- `/atelier usage`: child-usage graph.
- `/atelier disable`: release the gutter and restore the host footer/editor.
- `/atelier enable`: restore the status rail; use `/atelier sidebar on` to reopen a hidden sidebar.
- `/atelier-theme dark|light`: choose the companion `omk-atelier-dark` or `omk-atelier-light` theme. Startup never overrides an explicit theme setting.

In manual mode, Ctrl+Shift+R starts resizing. Left/right or divider dragging changes width; Enter or mouse release confirms; Escape restores the previous width. Below 92 columns the sidebar hides. At the default width, auto mode collapses below 124 columns and reopens at 132.

## tmux pane backend

When OMK starts inside tmux, Atelier renders its existing live sidebar in a separate right pane instead of an in-process overlay. Press `Ctrl+Q` in the OMK input pane to close or reopen only that sidebar. The main pane keeps focus and no global tmux bindings are modified. The initial width is 44 columns, with at least 64 left for OMK; opening requires 93 columns in the current OMK pane. Use tmux's `resize-pane` to resize; native auto-collapse and `Ctrl+Shift+R` do not apply in this mode.

From the checkout root:

```bash
bash scripts/omk-tmux.sh
bash scripts/omk-tmux.sh --resume <session-id>
```

The launcher reuses an existing tmux environment without nesting it. A running OMK outside tmux cannot be moved by `/reload`: quit and resume it through the launcher. Outside tmux, the native sidebar remains available and `Ctrl+Q` controls it too.

The backend reuses Atelier's renderer, state and quota bridge. It streams bounded frames into an empty pane and checks a per-instance ownership marker before writing or removing it. Disable, reload and normal shutdown release the owned pane and output connection; unrelated panes are untouched. No credential files or extra provider clients are introduced.

## Host integration

The extension reuses OMK's Pi import aliases and extension events. Its native adapter reserves space with `TUI.setRightGutter` and renders the sidebar in a non-capturing overlay, without Pi 0.84 fullscreen renderer hooks. The themes are contributed through `resources_discover` and the package's `omk.themes` manifest. They share the host's required 51 color tokens.

User preferences remain in `pi-atelier.json` inside the OMK agent directory; project preferences use `.omk/pi-atelier.json`. The upstream configuration layer, plain-font mode and bounded sidebar contribution protocol are retained. Native `update_todo` inputs and `todo` task results update the sidebar; successful native TODO results are reconstructed from the current session branch on reload.

Git inspection is read-only. The extension adds no credential reader or provider client: it reuses the host's configured usage transport, TTL cache, passive revisions and subscription allowlist. Theme changes do not force the terminal emulator's background color. Only one custom footer and editor can be active: other extensions may supersede these according to load order.
Atelier claims `Ctrl+Q` while loaded. If the host also pins its built-in rail, set `pinStatusSidebar` to `false` in the host settings to avoid a duplicate; Atelier does not rewrite that preference. The native adapter restores the previous gutter on hide/dispose and does not erase a later owner's gutter. Persistent components follow OMK's replacement Theme instances on theme changes. Hosts without the project-trust API retain user configuration but skip project configuration and workspace inspection.

Child curves require owner-validated pi-subagents artifacts or verified native delegate receipts linked to this session's successful launch and retrieval. Native delegate curves describe final-response usage only, not unobserved whole-run spend. Unknown costs remain unavailable; OMK background shell/AdaptOrch runs are not automatically interpreted as pi-subagents runs. Native graphics depend on terminal support, with text fallback. macOS/Windows notifications are retained; Linux notifications are not added.
## Usage data

- **USAGE**: session input, output, cache read, cache write, cache hit, total tokens and reported model cost. Token totals accumulate session assistant entries, matching the host footer; context remains the current request estimate. Cost is a model-price estimate, not the subscription bill.
- **QUOTA** (`omk:subscription-usage`): every configured host subscription group, with independently observed used percentages, window labels and reset countdowns. The active group is first. `subscriptionUsageProviders` remains authoritative; an empty allowlist disables requests. Missing windows, unsupported APIs, offline state and Meta's `no observed usage yet` remain unavailable, never 0%.
- The OMK quota panel is enabled by default next to context without changing saved preferences. An explicitly hidden panel stays hidden. The footer also carries a width-clipped summary when the sidebar is collapsed or too short. Use Display to hide/reorder optional panels when the terminal cannot fit every row.
- The shared host cache starts requests from the custom footer even when the built-in rail is hidden. Native rail and Atelier do not create duplicate polling loops. Existing host transport behavior is unchanged; no inference call is needed for the tests below.
- This bridge needs the source host's optional `footerData.getSubscriptionUsage()` API. Older installed engines display `host usage unavailable`; `/reload` refreshes the extension but cannot add that core API to an already-running older engine. Do not interpret this state as an authentication failure.

## Verification and provenance

Run from the checkout root:

```bash
npm --prefix .omk/extensions/atelier run typecheck
npm --prefix .omk/extensions/atelier test
npm run check
```

For a temporary interactive session, run outside the checkout with no other extensions:

```bash
omk --no-session --no-extensions -e /absolute/path/to/omk/.omk/extensions/atelier/index.ts
```

The vendored runtime is pinned to upstream commit `776c1e3701d7fced2115cdef27a58ca9f0f0bf07`; its MIT copyright and license are retained in `vendor/LICENSE`. Host adaptations and file hashes are recorded in the package's `UPSTREAM.json`. This is a checkout integration, not a published OMK release or an already-reloaded running session.
