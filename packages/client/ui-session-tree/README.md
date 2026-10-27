# ui-session-tree

English | [中文](README.zh.md)

Browser half of the session-tree plugin. It registers a **Session tree** tab in
the conversation View bar (`conversation.view`, after Chat and Trajectory) that
shows the open Session's merged lineage graph. It never renders above the
composer and creates no standalone page.

- The tab merges every non-subagent Session in the current lineage into one
  graph. Session topology comes from the reactive native Session list, while
  node topology comes from read-only `sessionTree.list` calls: each lineage
  Session is read once, then again only when its own list row changes (at most
  once per second, with one request in flight per Session). Native fork/clone
  prefixes are deduplicated only when both `nodeId` and `sessionEventSeq`
  match; branch-specific nodes keep session-qualified identities.
- ⑂ on a node opens an independent session copy from that node under the
  current project; its inline branch title is the user message immediately
  before the node. `/clone` duplicates the whole current conversation into a
  new same-project session.
- Fork points carry main/fork/clone badges and optional branch names. The open
  Session and its path stay highlighted, clicking another Session's node opens
  that Session before jumping, and Session branches or node subtrees collapse
  independently. A failed Session load becomes a local placeholder and does
  not break the rest of the graph.
- A fixed 44px, five-lane graph gutter draws vertical rails and curved branch
  connectors in an IDEA Git-log style: later children branch from their fork
  row, and lane lines stretch over taller rows. Lanes are bounded and reused;
  tree depth never becomes CSS margin or padding, so horizontal width is
  bounded. Rows render in groups that skip layout off screen, so lineages with
  thousands of nodes scroll and collapse smoothly.
- Branch heads, role, branch name, summary, refresh, and one-click fork use
  native `--dsw-alias-*` design tokens in light and dark themes.

## Inline fork branch menu

After a node fork creates a child session, an additive `shell.overlay` entry
(`session-tree-branches`) portals a collapsible menu directly after the source
Session's native list row. This is the left-side session-list menu; it is
separate from the merged graph in the Session tree tab. Forked children
appear inside that menu with connector rails, elbow joints, and per-level
expand/collapse controls. The child title is the user message immediately
preceding the selected node. The menu opens when a fork lands and follows the
reactive Session list, so new branches appear without a browser refresh.

Presentation-only by construction: the fork data and the parent linkage come
from the official native fork API (`ctx.sessions.fork` writes each child with
`parentId`), and the menu derives its cascade purely from that reactive list.
While a child is represented inline, its native list row is hidden and restored
when the menu unmounts. A small UI-layer lineage registry (`fork-lineage.ts`,
persisted to
`localStorage`) only marks which children came from a node fork — so `/clone`
sessions and ordinary sessions never enter the menu and keep their original
sidebar presentation. The `sidebar` slot itself stays untouched: it is
single-occupant (replacing it would remove the shipped workspace and settings
seats), so the additive `shell.overlay` entry is the seat for inline rendering.

## Composition

```yaml
- id: ui-session-tree
  name: '@robiteame/dsh-client-ui-session-tree'
```

The official standalone Bundle already supplies both Host services and this
browser package. A patched source checkout additionally requires the two Host
packages from `dev/harness.patch`.

## Model Experience

This is presentation-only. It reads and navigates the shared SessionTree; no
panel content enters model context or changes KV-cache prefixes.
