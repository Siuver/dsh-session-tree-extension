# @siuver/dsh-session-tree

Carrier Bundle for [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)
adding Pi-style append-only multi-branch session trees. Installing this one
package mounts all three implementation packages through its
`cordis.patch.yml` composition layer:

| Composition row | Package | Role |
|---|---|---|
| `pi-agent-session-tree` | `@siuver/dsh-pi-agent-session-tree` | `SessionTree`/`SessionTreeStore` domain service and the `sessionTree` Remote (`list`/`jump`/`fork`/`session`) |
| `tool-session-tree` | `@siuver/dsh-tool-session-tree` | `session_tree` tool, `/clone` `/session` commands, system-prompt section |
| `ui-session-tree` | `@siuver/dsh-client-ui-session-tree` | WebUI **Session tree** tab beside Chat and Trajectory |

## Install

In DeepSeek Harness Desktop, install this package from the in-app plugin market
and restart the app; the desktop plugin manager activates the bundle. On a CLI
that ships the `0.2.1-rc.3` plugin manager:

```sh
dsh plugin --profile <profile> add @siuver/dsh-session-tree
```

The published package is self-contained: the three prebuilt implementation
packages and their non-Harness runtime dependencies ship in its
`node_modules` (`bundledDependencies`), so no other `@siuver/*` package is
fetched. For local code, run `pnpm pack:local` from the repository root, then
install the complete local directory or its portable archive:

```sh
dsh plugin --profile web add ./dist/session-tree-local
# alternatively:
dsh plugin --profile web add ./dist/siuver-dsh-session-tree-1.0.0-local.tgz
```

A directory install keeps a link to that directory; retain the directory for
as long as the bundle is installed.

The carrier has no code of its own: `dsh.bundle.patch` points the composition
loader at the bundled implementation packages. Requires DeepSeek-Harness
`0.2.1-rc.2` through `0.2.1-rc.3` (the current desktop build is `0.2.1-rc.2`,
the latest published `next` is `0.2.1-rc.3`) and Cordis `~4.0.5`; the target
installation provides those peers.

See the [repository README](https://github.com/Siuver/dsh-session-tree-extension)
for the full feature tour, degradation behaviour on stock Harness builds,
and development instructions.

## License

MIT.
