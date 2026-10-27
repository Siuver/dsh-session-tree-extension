/**
 * Read-only projection of a Session lineage into one merged node graph.
 *
 * Session-level topology comes from the native Session list. Node-level
 * topology comes from each Session's own tree view. Native forks copy the
 * source log prefix verbatim, so the entries a child holds identically under
 * the same copied parent form the shared prefix, and its deepest entry is the
 * fork anchor. Only that prefix is deduplicated; every branch-specific node
 * keeps a session-qualified identity.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeView, TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import type { ForkLineageEntry } from './fork-lineage.ts'
import { isInjectedUserNode } from './node-text.ts'

/** Which kind of Session a row represents. */
export type BranchTreeBadge = 'main' | 'fork' | 'clone'

/** One Session in the derived lineage. */
export interface BranchTreeRow {
  readonly sessionId: SessionId
  readonly parentId: SessionId | undefined
  readonly title: string
  /** 0 is the trunk root; each nesting level adds one. */
  readonly depth: number
  /** Last sibling stops the parent rail below its elbow. */
  readonly isLast: boolean
  /** Per ancestor level above the parent: whether its rail continues below. */
  readonly railContinues: readonly boolean[]
  readonly childCount: number
  readonly running: boolean
  /** The Session the UI currently has open. */
  readonly current: boolean
  /** On the root-to-current chain. */
  readonly onActivePath: boolean
  readonly badge: BranchTreeBadge
  readonly branchLabel: string | undefined
}

/** Derived Session-level lineage in DFS pre-order. */
export interface BranchTreeModel {
  readonly rows: readonly BranchTreeRow[]
  readonly rootId: SessionId
  readonly highlightedId: SessionId
  readonly activeAncestors: ReadonlySet<SessionId>
}

/** Read-only projection input shared by the graph builder and tests. */
export interface BranchTreeListState {
  readonly ids?: readonly SessionId[]
  readonly byId?: Readonly<Record<SessionId, unknown>> | undefined
  readonly current?: SessionId | undefined
}

interface SessionRowView {
  readonly parentId: SessionId | undefined
  readonly displayTitle: string | undefined
  readonly running: boolean
  readonly updatedAt: number
  readonly subagent: boolean
}

/** One badge rendered where a Session branch starts. */
export interface SessionGraphBadge {
  readonly sessionId: SessionId
  readonly kind: BranchTreeBadge
  readonly branchLabel: string | undefined
  readonly title: string
  readonly running: boolean
  readonly current: boolean
  /** Stable identity for independently collapsing this Session branch. */
  readonly collapseKey: string
  /** Whether collapsing this badge can hide at least one branch-owned row. */
  readonly hasChildren: boolean
}

/** Why a Session has a synthetic placeholder row instead of its nodes. */
export type SessionGraphPlaceholder = 'loading' | 'error' | 'empty'

/** One render-ready node row in the merged graph. */
export interface SessionGraphRow {
  /** Session-qualified key for unique nodes; the shared key for a copied prefix. */
  readonly key: string
  readonly parentKey: string | null
  readonly node: TreeNode
  readonly owners: readonly SessionId[]
  readonly badges: readonly SessionGraphBadge[]
  readonly lane: number
  /** Lane the incoming edge descends from; a later sibling descends its own reserved lane. */
  readonly parentLane: number | null
  /** Lanes reserved for later siblings of an ancestor, drawn as vertical rails. */
  readonly continues: readonly number[]
  /** Lanes this node's later children branch into, drawn from this row's node. */
  readonly splitLanes: readonly number[]
  /** Rails and split lanes that lead to a node on the current Session's path. */
  readonly activeLanes: readonly number[]
  readonly hasChildren: boolean
  /** Branch-owned rows hidden by this row's branch collapse keys. */
  readonly branchKeys: readonly string[]
  /** The current Session's selected node. */
  readonly active: boolean
  /** On the current Session's selected-node path. */
  readonly onActivePath: boolean
  readonly placeholder: SessionGraphPlaceholder | undefined
  /** Palette slot of the Session this entry originates from. */
  readonly color: number
  /** Histories leaving this row through an entry not drawn right below it. */
  readonly branchOffs: readonly SessionGraphBranchOff[]
}

/** One history leaving a row: the Session it belongs to and its first entry. */
export interface SessionGraphBranchOff {
  readonly sessionId: SessionId
  readonly key: string
}

/** One lineage Session summarized for the branch overview. */
export interface SessionGraphBranch {
  readonly sessionId: SessionId
  readonly parentId: SessionId | undefined
  readonly title: string
  readonly kind: BranchTreeBadge
  readonly branchLabel: string | undefined
  readonly depth: number
  readonly isLast: boolean
  readonly railContinues: readonly boolean[]
  readonly running: boolean
  readonly current: boolean
  readonly onActivePath: boolean
  /** Palette slot shared by this Session's badge, chips, and graph dots. */
  readonly color: number
  /** Typed prompts copied from ancestors: the turn this Session branched after. */
  readonly inheritedTurns: number
  /** Typed prompts this Session added itself. */
  readonly ownTurns: number
  /** Summary of the first typed prompt this Session added. */
  readonly firstPrompt: string | undefined
  /** Row carrying this Session's badge, where its own history starts. */
  readonly startKey: string | undefined
  /** Copied row its own history continues from; undefined for the trunk. */
  readonly forkKey: string | undefined
  readonly placeholder: SessionGraphPlaceholder | undefined
}

/** Complete merged graph plus the keys needed for reveal-on-open behavior. */
export interface SessionGraphModel {
  readonly rows: readonly SessionGraphRow[]
  readonly sessionIds: readonly SessionId[]
  readonly failedSessionIds: readonly SessionId[]
  readonly highlightedId: SessionId
  readonly activePathKeys: ReadonlySet<string>
  readonly activeBranchKeys: ReadonlySet<string>
  /** Every lineage Session, in topology order, whatever the focus. */
  readonly branches: readonly SessionGraphBranch[]
  /** The Session whose history alone fills `rows`, when one branch is focused. */
  readonly focusSessionId: SessionId | undefined
}

/** Distinct branch colors; the trunk keeps slot 0 and later Sessions cycle through the rest. */
export const BRANCH_COLOR_COUNT = 6

function branchColor(topologyIndex: number): number {
  return topologyIndex <= 0 ? 0 : 1 + ((topologyIndex - 1) % (BRANCH_COLOR_COUNT - 1))
}

interface MutableGraphNode {
  readonly key: string
  readonly node: TreeNode
  parentKey: string | null
  readonly owners: Set<SessionId>
  readonly badges: SessionGraphBadge[]
  readonly branchKeys: Set<string>
  order: number
  readonly placeholder: SessionGraphPlaceholder | undefined
}

function rowViewOf(summary: unknown): SessionRowView {
  const row = (summary ?? {}) as {
    parentId?: unknown
    displayTitle?: unknown
    running?: unknown
    updatedAt?: unknown
    origin?: unknown
  }
  return {
    parentId: typeof row.parentId === 'string' ? row.parentId as SessionId : undefined,
    displayTitle: typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : undefined,
    running: row.running === true,
    updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
    subagent: row.origin === 'subagent',
  }
}

/**
 * Flatten one Session lineage into ordered worktree rows. The trunk is the
 * oldest ancestor of `sessionId` still present in the live list; children
 * nest under their parent ordered by creation, then list order. Cycles and
 * missing rows are skipped, never followed.
 */
export function buildBranchTreeModel(
  sessionId: SessionId,
  state: BranchTreeListState,
  entries: ReadonlyMap<SessionId, ForkLineageEntry>,
): BranchTreeModel | null {
  const byId = state.byId ?? {}
  if (!Object.prototype.hasOwnProperty.call(byId, sessionId)) return null

  const viewOf = (id: SessionId): SessionRowView | undefined =>
    Object.prototype.hasOwnProperty.call(byId, id) ? rowViewOf(byId[id]) : undefined

  const parentOf = (id: SessionId): SessionId | undefined => {
    const parentId = viewOf(id)?.parentId
    if (parentId === undefined || parentId === id) return undefined
    return viewOf(parentId) === undefined ? undefined : parentId
  }

  const rootChain: SessionId[] = []
  const walkSeen = new Set<SessionId>()
  for (let cursor: SessionId | undefined = sessionId; cursor !== undefined && !walkSeen.has(cursor); ) {
    walkSeen.add(cursor)
    rootChain.push(cursor)
    cursor = parentOf(cursor)
  }
  const rootId: SessionId = rootChain[rootChain.length - 1]!

  const ids = state.ids ?? (Object.keys(byId) as SessionId[])
  const orderOf = (id: SessionId): number => {
    const index = ids.indexOf(id)
    return index === -1 ? Number.MAX_SAFE_INTEGER : index
  }
  const createdAtOf = (id: SessionId): number => entries.get(id)?.createdAt ?? viewOf(id)?.updatedAt ?? 0

  const childIds = new Map<SessionId, SessionId[]>()
  for (const id of Object.keys(byId) as SessionId[]) {
    const view = viewOf(id)
    if (view?.subagent === true) continue
    const parentId = parentOf(id)
    if (parentId === undefined) continue
    const siblings = childIds.get(parentId)
    if (siblings === undefined) childIds.set(parentId, [id])
    else siblings.push(id)
  }
  const siblingsOf = (parentId: SessionId): readonly SessionId[] =>
    (childIds.get(parentId) ?? []).slice().sort((a, b) => createdAtOf(a) - createdAtOf(b) || orderOf(a) - orderOf(b))

  interface TopologyRow {
    id: SessionId
    depth: number
    isLast: boolean
    railContinues: readonly boolean[]
  }
  const topology: TopologyRow[] = []
  const subtree = new Set<SessionId>()
  const visit = (
    siblings: readonly SessionId[],
    depth: number,
    railContinues: readonly boolean[],
    ancestors: ReadonlySet<SessionId>,
  ): void => {
    siblings.forEach((id, index) => {
      if (ancestors.has(id)) return
      const isLast = index === siblings.length - 1
      topology.push({ id, depth, isLast, railContinues })
      subtree.add(id)
      const nextAncestors = new Set(ancestors)
      nextAncestors.add(id)
      visit(siblingsOf(id), depth + 1, [...railContinues, !isLast], nextAncestors)
    })
  }
  visit([rootId], 0, [], new Set())

  const highlightedId: SessionId = state.current !== undefined && subtree.has(state.current) ? state.current : sessionId
  const activeAncestors = new Set<SessionId>()
  for (let cursor = highlightedId; cursor !== rootId; ) {
    const parentId = parentOf(cursor)
    if (parentId === undefined || activeAncestors.has(parentId)) break
    activeAncestors.add(parentId)
    cursor = parentId
  }

  const rows: BranchTreeRow[] = topology.map(({ id, depth, isLast, railContinues }) => {
    const entry = entries.get(id)
    const view = viewOf(id)
    return {
      sessionId: id,
      parentId: parentOf(id),
      title: entry?.summary ?? view?.displayTitle ?? id,
      depth,
      isLast,
      railContinues,
      childCount: siblingsOf(id).length,
      running: view?.running === true,
      current: id === highlightedId,
      onActivePath: id === highlightedId || activeAncestors.has(id),
      badge: depth === 0 ? 'main' : entry !== undefined ? 'fork' : 'clone',
      branchLabel: entry?.branch,
    }
  })
  return { rows, rootId, highlightedId, activeAncestors }
}

/**
 * Per-Session revision of the list-row fields that signal a changed tree.
 * Only these values decide when a Session's tree is read again, so traffic
 * from Sessions outside the lineage never refetches it.
 */
export function lineageRevisions(
  state: BranchTreeListState,
  ids: readonly SessionId[],
): ReadonlyMap<SessionId, string> {
  const byId = state.byId ?? {}
  return new Map(ids.map(id => {
    const view = Object.prototype.hasOwnProperty.call(byId, id) ? rowViewOf(byId[id]) : undefined
    return [id, view === undefined ? '' : `${String(view.updatedAt)}:${String(view.running)}`]
  }))
}

/**
 * Everything the merged graph reads from one session-list snapshot: the
 * lineage topology plus each lineage Session's revision. Two snapshots with
 * the same signature render the same graph.
 */
export function lineageSignature(
  sessionId: SessionId,
  state: BranchTreeListState,
  entries: ReadonlyMap<SessionId, ForkLineageEntry>,
): string {
  const topology = buildBranchTreeModel(sessionId, state, entries)
  if (topology === null) return ''
  const revisions = lineageRevisions(state, topology.rows.map(row => row.sessionId))
  return JSON.stringify([topology.rootId, topology.highlightedId, topology.rows, [...revisions]])
}

/** Pre-order rows minus the descendants of collapsed rows. */
export function visibleBranchRows(
  rows: readonly BranchTreeRow[],
  collapsed: ReadonlySet<SessionId>,
): BranchTreeRow[] {
  const visible: BranchTreeRow[] = []
  let skipDepth = 0
  for (const row of rows) {
    if (skipDepth > 0 && row.depth >= skipDepth) continue
    skipDepth = 0
    visible.push(row)
    if (collapsed.has(row.sessionId)) skipDepth = row.depth + 1
  }
  return visible
}

function nodeSequence(node: TreeNode): number | undefined {
  const primary = node.metadata?.sessionEventSeq
  if (typeof primary === 'number' && Number.isSafeInteger(primary)) return primary
  const source = node.metadata?.sourceEventSeq
  return typeof source === 'number' && Number.isSafeInteger(source) ? source : undefined
}

/**
 * Identity of one history entry across Sessions. A fork copies the source log
 * verbatim, so id, sequence, timestamp, and summary all survive the copy;
 * entries appended after the fork reuse ids and sequences, never all four.
 */
function nodeIdentity(node: TreeNode): string {
  const seq = nodeSequence(node)
  return [node.nodeId, seq === undefined ? '' : String(seq), node.createdAt, node.summary].join('\u0000')
}

/**
 * Child entries copied from the parent Session, mapped to the parent's graph
 * keys. An entry is copied when the parent holds the same entry under the same
 * copied parent, so the match follows the tree instead of either Session's
 * selected path: a child whose cursor jumped back still shares its whole copy.
 */
function sharedPrefixKeys(
  view: SessionTreeView,
  parentView: SessionTreeView,
  parentKeys: ReadonlyMap<string, string>,
): Map<string, string> {
  const parentByIdentity = new Map(parentView.nodes.map(node => [nodeIdentity(node), node]))
  const byId = new Map(view.nodes.map(node => [node.nodeId, node]))
  const resolved = new Map<string, string | null>()
  for (const start of view.nodes) {
    // Resolve the unresolved ancestor chain top-down; conversations are too
    // deep to recurse, and the seen set stops at parent-link cycles.
    const chain: TreeNode[] = []
    const seen = new Set<string>()
    for (
      let cursor: TreeNode | undefined = start;
      cursor !== undefined && !resolved.has(cursor.nodeId) && !seen.has(cursor.nodeId);
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
    ) {
      seen.add(cursor.nodeId)
      chain.push(cursor)
    }
    for (let index = chain.length - 1; index >= 0; index--) {
      const node = chain[index]!
      const match = parentByIdentity.get(nodeIdentity(node))
      const key = match === undefined ? undefined : parentKeys.get(match.nodeId)
      let shared: string | null = null
      if (match !== undefined && key !== undefined) {
        if (node.parentId === null || match.parentId === null) {
          if (node.parentId === match.parentId) shared = key
        } else {
          const parentShared = resolved.get(node.parentId)
          if (parentShared !== undefined && parentShared !== null && parentShared === parentKeys.get(match.parentId)) {
            shared = key
          }
        }
      }
      resolved.set(node.nodeId, shared)
    }
  }
  const shared = new Map<string, string>()
  for (const [nodeId, key] of resolved) {
    if (key !== null) shared.set(nodeId, key)
  }
  return shared
}

/** Root-to-selected/cursor path, with defensive fallback for sparse views. */
function pathToNode(view: SessionTreeView): TreeNode[] {
  const byId = new Map(view.nodes.map(node => [node.nodeId, node]))
  const preferred = view.selectedNodeId
  let current = typeof preferred === 'string' && byId.has(preferred)
    ? preferred
    : view.cursor !== null && byId.has(view.cursor)
      ? view.cursor
      : view.nodes.at(-1)?.nodeId ?? null
  const path: TreeNode[] = []
  const seen = new Set<string>()
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const node = byId.get(current)
    if (node === undefined) break
    path.push(node)
    current = node.parentId
  }
  return path.reverse()
}

function placeholderNode(row: BranchTreeRow, kind: SessionGraphPlaceholder): TreeNode {
  return {
    nodeId: `__session-tree-${kind}__`,
    parentId: null,
    branch: 'main',
    type: 'custom',
    summary: row.title,
    createdAt: '',
    metadata: { sessionGraphPlaceholder: kind },
  }
}

function branchKey(sessionId: SessionId, anchorNodeId: string): string {
  return `${sessionId}:${anchorNodeId}`
}

function orderedViewNodes(view: SessionTreeView): readonly TreeNode[] {
  return view.nodes.slice().sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.nodeId.localeCompare(right.nodeId),
  )
}

/** A human prompt typed into the conversation, the unit a turn starts with. */
function isTypedPrompt(node: TreeNode): boolean {
  return node.message?.role === 'user' && node.type !== 'compaction' && !isInjectedUserNode(node)
}

/**
 * Merge every available Session view into one tree. The first Session row is
 * the trunk. Each child reconnects to the entries it copied from its Session
 * parent; the deepest copied entry is the fork point. A child whose view is
 * unavailable contributes one placeholder row and never fails the rest of the
 * graph.
 * @param focusSessionId - lay out only this Session's history; the others
 *   appear as branch-offs on the rows they leave from.
 */
export function buildSessionGraphModel(
  topology: BranchTreeModel,
  views: ReadonlyMap<SessionId, SessionTreeView>,
  failed: ReadonlySet<SessionId>,
  focusSessionId?: SessionId,
): SessionGraphModel {
  const graph = new Map<string, MutableGraphNode>()
  const sessionMaps = new Map<SessionId, ReadonlyMap<string, string>>()
  const sessionTails = new Map<SessionId, string>()
  const sessionBranchKeys = new Map<SessionId, readonly string[]>()
  const branchKeyBySession = new Map<SessionId, string>()
  const startKeyBySession = new Map<SessionId, string>()
  const rowOrder = new Map(topology.rows.map((row, index) => [row.sessionId, index]))
  const failedSessionIds: SessionId[] = []

  const addNode = (
    key: string,
    node: TreeNode,
    parentKey: string | null,
    order: number,
    placeholder: SessionGraphPlaceholder | undefined,
  ): MutableGraphNode => {
    const existing = graph.get(key)
    if (existing !== undefined) {
      existing.order = Math.min(existing.order, order)
      return existing
    }
    const created: MutableGraphNode = {
      key,
      node,
      parentKey,
      owners: new Set(),
      badges: [],
      branchKeys: new Set(),
      order,
      placeholder,
    }
    graph.set(key, created)
    return created
  }

  const addOwner = (key: string, sessionId: SessionId): void => {
    graph.get(key)?.owners.add(sessionId)
  }

  const addBranchKeys = (key: string, keys: readonly string[]): void => {
    const target = graph.get(key)
    if (target === undefined) return
    for (const value of keys) target.branchKeys.add(value)
  }

  const addBadge = (
    key: string,
    row: BranchTreeRow,
    collapseKey: string,
    hasChildren: boolean,
  ): void => {
    const target = graph.get(key)
    if (target === undefined) return
    startKeyBySession.set(row.sessionId, key)
    target.badges.push({
      sessionId: row.sessionId,
      kind: row.badge,
      branchLabel: row.branchLabel,
      title: row.title,
      running: row.running,
      current: row.current,
      collapseKey,
      hasChildren,
    })
  }

  const mergeSession = (row: BranchTreeRow, order: number): void => {
    const nodeKeys = new Map<string, string>()
    const view = views.get(row.sessionId)
    const parentId = row.parentId
    const parentView = parentId === undefined ? undefined : views.get(parentId)
    const parentKeys = parentId === undefined ? undefined : sessionMaps.get(parentId)
    const fallbackParentKey = parentId === undefined ? null : sessionTails.get(parentId) ?? null
    const inheritedBranchKeys = parentId === undefined ? [] : sessionBranchKeys.get(parentId) ?? []

    if (view === undefined || failed.has(row.sessionId)) {
      const kind: SessionGraphPlaceholder = failed.has(row.sessionId) ? 'error' : 'loading'
      const key = `${row.sessionId}:__session-tree-${kind}__`
      const node = placeholderNode(row, kind)
      const collapseKey = branchKey(row.sessionId, node.nodeId)
      addNode(key, node, fallbackParentKey, order, kind)
      addOwner(key, row.sessionId)
      addBranchKeys(key, [...inheritedBranchKeys, collapseKey])
      addBadge(key, row, collapseKey, false)
      sessionMaps.set(row.sessionId, new Map([[node.nodeId, key]]))
      sessionTails.set(row.sessionId, key)
      sessionBranchKeys.set(row.sessionId, [...inheritedBranchKeys, collapseKey])
      branchKeyBySession.set(row.sessionId, collapseKey)
      if (kind === 'error') failedSessionIds.push(row.sessionId)
      return
    }

    const childPath = pathToNode(view)
    const sharedParentKeys = parentView === undefined || parentKeys === undefined
      ? new Map<string, string>()
      : sharedPrefixKeys(view, parentView, parentKeys)
    const sharedChildIds = new Set(sharedParentKeys.keys())

    for (const node of view.nodes) {
      nodeKeys.set(node.nodeId, sharedParentKeys.get(node.nodeId) ?? `${row.sessionId}:${node.nodeId}`)
    }

    const anchorNodeId = childPath.at(-1) !== undefined && sharedChildIds.has(childPath.at(-1)!.nodeId)
      ? childPath.filter(node => sharedChildIds.has(node.nodeId)).at(-1)?.nodeId
      : undefined
    const rootAnchorNodeId = childPath[0]?.nodeId ?? orderedViewNodes(view)[0]?.nodeId ?? '__root__'
    const ownBranchKey = branchKey(row.sessionId, anchorNodeId ?? rootAnchorNodeId)
    const branchKeys = [...inheritedBranchKeys, ownBranchKey]
    sessionBranchKeys.set(row.sessionId, branchKeys)
    branchKeyBySession.set(row.sessionId, ownBranchKey)

    for (const node of view.nodes) {
      const key = nodeKeys.get(node.nodeId)
      if (key === undefined) continue
      const parentKey = node.parentId === null
        ? fallbackParentKey
        : nodeKeys.get(node.parentId) ?? fallbackParentKey
      addNode(
        key,
        node,
        sharedParentKeys.has(node.nodeId) ? graph.get(key)?.parentKey ?? parentKey : parentKey,
        order,
        undefined,
      )
      addOwner(key, row.sessionId)
      if (!sharedChildIds.has(node.nodeId)) addBranchKeys(key, branchKeys)
    }

    if (view.nodes.length === 0) {
      const kind: SessionGraphPlaceholder = 'empty'
      const key = `${row.sessionId}:__session-tree-empty__`
      const node = placeholderNode(row, kind)
      const collapseKey = branchKey(row.sessionId, node.nodeId)
      addNode(key, node, fallbackParentKey, order, kind)
      addOwner(key, row.sessionId)
      addBranchKeys(key, [...branchKeys, collapseKey])
      addBadge(key, row, collapseKey, false)
      sessionMaps.set(row.sessionId, new Map([[node.nodeId, key]]))
      sessionTails.set(row.sessionId, key)
      sessionBranchKeys.set(row.sessionId, [...branchKeys, collapseKey])
      branchKeyBySession.set(row.sessionId, collapseKey)
      return
    }

    const unsharedNodes = view.nodes.filter(node => !sharedChildIds.has(node.nodeId))
    const badgeNode = row.parentId === undefined
      ? childPath[0] ?? orderedViewNodes(view)[0]
      : childPath.find(node => !sharedChildIds.has(node.nodeId))
        ?? orderedViewNodes(view).find(node => !sharedChildIds.has(node.nodeId))
        ?? childPath.at(-1)
    const badgeKey = badgeNode === undefined ? undefined : nodeKeys.get(badgeNode.nodeId)
    const collapseKey = ownBranchKey ?? branchKey(row.sessionId, badgeNode?.nodeId ?? '__root__')
    if (badgeKey !== undefined) addBadge(badgeKey, row, collapseKey, unsharedNodes.length > 0)

    const tailNode = childPath.at(-1) ?? orderedViewNodes(view).at(-1)
    const tailKey = tailNode === undefined ? fallbackParentKey : nodeKeys.get(tailNode.nodeId) ?? fallbackParentKey
    sessionMaps.set(row.sessionId, nodeKeys)
    sessionTails.set(row.sessionId, tailKey ?? fallbackParentKey ?? `${row.sessionId}:__session-tree-empty__`)
  }

  topology.rows.forEach((row, order) => { mergeSession(row, order) })

  // Ancestors precede descendants in topology order, so the first owner is
  // the Session an entry was written in; later owners only copied it.
  const ownersByKey = new Map<string, readonly SessionId[]>()
  for (const node of graph.values()) {
    ownersByKey.set(node.key, [...node.owners].sort((a, b) => (rowOrder.get(a) ?? 0) - (rowOrder.get(b) ?? 0)))
  }
  const originOf = (key: string): SessionId | undefined => ownersByKey.get(key)?.[0]

  const children = new Map<string, string[]>()
  for (const node of graph.values()) {
    if (node.parentKey === null || !graph.has(node.parentKey)) continue
    const siblings = children.get(node.parentKey)
    if (siblings === undefined) children.set(node.parentKey, [node.key])
    else siblings.push(node.key)
  }
  const compareKeys = (leftKey: string, rightKey: string): number => {
    const left = graph.get(leftKey)!
    const right = graph.get(rightKey)!
    return left.order - right.order
      || left.node.createdAt.localeCompare(right.node.createdAt)
      || left.key.localeCompare(right.key)
  }
  for (const siblings of children.values()) siblings.sort(compareKeys)

  // A focused branch lays out only the entries its Session holds: its own
  // history plus everything it copied from its ancestors.
  const focusId = focusSessionId !== undefined && rowOrder.has(focusSessionId) ? focusSessionId : undefined
  const laidOut = (key: string): boolean => focusId === undefined || graph.get(key)?.owners.has(focusId) === true
  const layoutChildren = focusId === undefined
    ? children
    : new Map([...children].map(([key, siblings]) => [key, siblings.filter(laidOut)]))
  const sortedRoots = [...graph.values()]
    .filter(node => laidOut(node.key)
      && (node.parentKey === null || !graph.has(node.parentKey) || !laidOut(node.parentKey)))
    .map(node => node.key)
    .sort(compareKeys)

  /** Histories leaving `key` through a child not drawn directly below it. */
  const branchOffsOf = (key: string): SessionGraphBranchOff[] => {
    const all = children.get(key) ?? []
    const leaving = focusId === undefined
      ? all.slice(1).filter(child => originOf(child) !== originOf(key))
      : all.filter(child => !laidOut(child))
    const offs: SessionGraphBranchOff[] = []
    for (const child of leaving) {
      const sessionId = originOf(child)
      if (sessionId !== undefined && !offs.some(off => off.sessionId === sessionId)) offs.push({ sessionId, key: child })
    }
    return offs
  }

  const turns = new Map<SessionId, { inherited: number; own: number; first: TreeNode | undefined }>(
    topology.rows.map(row => [row.sessionId, { inherited: 0, own: 0, first: undefined }]),
  )
  for (const node of graph.values()) {
    if (node.placeholder !== undefined || !isTypedPrompt(node.node)) continue
    ownersByKey.get(node.key)?.forEach((owner, index) => {
      const counts = turns.get(owner)
      if (counts === undefined) return
      if (index > 0) {
        counts.inherited += 1
        return
      }
      counts.own += 1
      if (counts.first === undefined || node.node.createdAt < counts.first.createdAt) counts.first = node.node
    })
  }
  const branches: SessionGraphBranch[] = topology.rows.map((row, index) => {
    const counts = turns.get(row.sessionId)
    const startKey = startKeyBySession.get(row.sessionId)
    const start = startKey === undefined ? undefined : graph.get(startKey)
    return {
      sessionId: row.sessionId,
      parentId: row.parentId,
      title: row.title,
      kind: row.badge,
      branchLabel: row.branchLabel,
      depth: row.depth,
      isLast: row.isLast,
      railContinues: row.railContinues,
      running: row.running,
      current: row.current,
      onActivePath: row.onActivePath,
      color: branchColor(index),
      inheritedTurns: counts?.inherited ?? 0,
      ownTurns: counts?.own ?? 0,
      firstPrompt: counts?.first?.summary,
      startKey,
      forkKey: row.parentId === undefined ? undefined : start?.parentKey ?? undefined,
      placeholder: start?.placeholder,
    }
  })

  const currentView = views.get(topology.highlightedId)
  const currentKeys = sessionMaps.get(topology.highlightedId)
  const activePathKeys = new Set<string>()
  if (currentView !== undefined && currentKeys !== undefined) {
    for (const node of pathToNode(currentView)) {
      const key = currentKeys.get(node.nodeId)
      if (key !== undefined) activePathKeys.add(key)
    }
  }

  const laneFor = (index: number): number => ((index % 5) + 5) % 5
  const currentSelected = currentView?.selectedNodeId ?? currentView?.cursor ?? null
  const rows: SessionGraphRow[] = []
  // Conversations are thousands of nodes deep, so the pre-order walk keeps an
  // explicit stack: recursion would overflow the call stack. Every key is
  // emitted once, which also breaks any parent-link cycle.
  const visited = new Set<string>()
  interface Frame {
    readonly key: string
    readonly lane: number
    readonly parentLane: number | null
    readonly inheritedRails: readonly number[]
    readonly activeRails: readonly number[]
  }
  const onActivePathOf = (key: string): boolean => {
    const node = graph.get(key)
    return activePathKeys.has(key)
      || (node?.placeholder !== undefined && node.owners.has(topology.highlightedId))
  }
  const stack: Frame[] = sortedRoots
    .map((key, index): Frame => ({ key, lane: laneFor(index), parentLane: null, inheritedRails: [], activeRails: [] }))
    .reverse()
  while (stack.length > 0) {
    const { key, lane, parentLane, inheritedRails, activeRails } = stack.pop()!
    if (visited.has(key)) continue
    const node = graph.get(key)
    if (node === undefined) continue
    const nodeChildren = layoutChildren.get(key) ?? []
    // The first child continues this lane; each later child branches from
    // this node into its own lane, reserved by a rail until its row.
    const childLanes = nodeChildren.map((_, index) => index === 0 ? lane : laneFor(lane + index))
    const childOnPath = nodeChildren.map(onActivePathOf)
    const splitLanes = childLanes.slice(1)
    const origin = originOf(key)
    rows.push({
      key,
      parentKey: node.parentKey,
      node: node.node,
      owners: ownersByKey.get(key) ?? [],
      badges: node.badges,
      lane,
      parentLane,
      continues: [...new Set(inheritedRails)].filter(value => value !== lane),
      splitLanes,
      activeLanes: [...new Set([
        ...activeRails.filter(value => value !== lane),
        ...splitLanes.filter((_, index) => childOnPath[index + 1]),
      ])],
      hasChildren: nodeChildren.length > 0,
      branchKeys: [...node.branchKeys],
      active: node.owners.has(topology.highlightedId)
        && currentSelected !== null
        && node.node.nodeId === currentSelected,
      onActivePath: onActivePathOf(key),
      placeholder: node.placeholder,
      color: branchColor(origin === undefined ? 0 : rowOrder.get(origin) ?? 0),
      branchOffs: branchOffsOf(key),
    })
    visited.add(key)
    // Push in reverse so the first child's subtree is emitted first.
    for (let index = nodeChildren.length - 1; index >= 0; index--) {
      const laterLanes = childLanes.slice(index + 1)
      const laterActive = laterLanes.filter((_, offset) => childOnPath[index + 1 + offset])
      stack.push({
        key: nodeChildren[index]!,
        lane: childLanes[index]!,
        parentLane: index === 0 ? lane : childLanes[index]!,
        inheritedRails: laterLanes.length === 0 ? inheritedRails : [...inheritedRails, ...laterLanes],
        activeRails: laterActive.length === 0 ? activeRails : [...activeRails, ...laterActive],
      })
    }
  }

  const activeBranchKeys = new Set<string>()
  for (const sessionId of [...topology.activeAncestors, topology.highlightedId]) {
    const key = branchKeyBySession.get(sessionId)
    if (key !== undefined) activeBranchKeys.add(key)
  }

  return {
    rows,
    sessionIds: topology.rows.map(row => row.sessionId),
    failedSessionIds,
    highlightedId: topology.highlightedId,
    activePathKeys,
    activeBranchKeys,
    branches,
    focusSessionId: focusId,
  }
}
