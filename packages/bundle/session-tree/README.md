# @robiteame/dsh-session-tree

Carrier Bundle for [DeepSeek-Harness](https://github.com/deepseek-ai/deepseek-harness)
adding Pi-style append-only multi-branch session trees. Installing this one
package mounts all three implementation packages through its
`cordis.patch.yml` composition layer:

| Composition row | Package | Role |
|---|---|---|
| `pi-agent-session-tree` | `@robiteame/dsh-pi-agent-session-tree` | `SessionTree`/`SessionTreeStore` domain service and the `sessionTree` Remote (`list`/`jump`/`fork`/`session`) |
| `tool-session-tree` | `@robiteame/dsh-tool-session-tree` | `session_tree` tool, `/tree` `/fork` `/clone` `/session` commands, system-prompt section |
| `ui-session-tree` | `@robiteame/dsh-client-ui-session-tree` | WebUI tree panel (additive right-side overlay on official builds, native details dock on patched builds) |

## Install

In DeepSeek Harness Desktop, install this package from the in-app plugin market
and restart the app; the desktop plugin manager activates the bundle. On a CLI
that ships the `0.2.1-rc.3` plugin manager:

```sh
dsh plugin --profile <profile> add @robiteame/dsh-session-tree
```

or install the prebuilt tarball:

```sh
dsh plugin --profile <profile> add robiteame-dsh-session-tree-0.7.0.tgz
```

This package carries no code of its own: `dependencies` pulls the three
implementation packages into the profile workspace and `dsh.bundle.patch`
points the composition loader at them. Requires DeepSeek-Harness
`0.2.1-rc.2` through `0.2.1-rc.3` (the current desktop build is `0.2.1-rc.2`,
the latest published `next` is `0.2.1-rc.3`) and Cordis `~4.0.5`; the target
installation provides those peers.

See the [repository README](https://github.com/robiteame/dsh-session-tree-extension)
for the full feature tour, degradation behaviour on stock Harness builds,
and development instructions.

## License

MIT.
