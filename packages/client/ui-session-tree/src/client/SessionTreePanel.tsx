/**
 * SessionTreePanel renders the Session tree Conversation View.
 *
 * The modern host path merges every Session in the current lineage into one
 * git-style graph, with a branch overview that can focus a single Session's
 * history and a conversation-only mode that folds tool traffic away.
 * Selector mode and older hosts keep the original single-Session view. Both
 * paths use a fixed-width graph gutter, so tree depth can never increase the
 * panel's horizontal width.
 */
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  LlmRole,
  SessionTreeForkView,
  SessionTreeView,
  TreeNode,
} from '@robiteame/dsh-pi-agent-session-tree/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionTreeViewProps } from './slots.ts'
import type { SessionTreeKey } from './locales.ts'
import { isConversationNode, isInjectedUserNode, nodeBodyText, nodeFullText } from './node-text.ts'
import {
  buildBranchTreeModel,
  buildSessionGraphModel,
  lineageRevisions,
  lineageSignature,
  type SessionGraphBadge,
  type SessionGraphBranch,
  type SessionGraphBranchOff,
  type SessionGraphPlaceholder,
  type SessionGraphRow,
} from './session-graph.ts'
import { BranchOverview, branchColorClass } from './BranchOverview.tsx'
import css from './SessionTreePanel.module.css'
import { currentSessionId } from './session-list.ts'

const ROLE_LABELS: Record<LlmRole, SessionTreeKey> = {
  system: 'node.role.system',
  user: 'node.role.user',
  assistant: 'node.role.assistant',
  tool: 'node.role.tool',
}
const GRAPH_LANES = 5
const LANE_X = [6, 14, 22, 30, 38] as const
const FAN_OUT_DEBOUNCE_MS = 80
/** A running Session updates its list row continuously; reread its tree at most this often. */
const REVISION_REFRESH_MS = 1000
/** Rows per `content-visibility` group: per-row groups make scrolling track thousands of elements. */
const ROW_CHUNK_SIZE = 50

/** How long a row revealed from the branch overview or a branch-off stays highlighted. */
const FLASH_MS = 1600
/** Metadata a conversation-only row carries: how many tool executions it folds away. */
const HIDDEN_TOOLS_KEY = 'sessionTreeHiddenTools'
const CONVERSATION_ONLY_STORAGE_KEY = 'session-tree.conversationOnly.v1'

const EMPTY_MODE_SNAPSHOT = { selectorOpen: false } as const
const NOOP_SUBSCRIBE = (_listener: () => void): (() => void) => () => {}
const NOOP_GET_MODE_SNAPSHOT = (): typeof EMPTY_MODE_SNAPSHOT => EMPTY_MODE_SNAPSHOT
const EMPTY_LINEAGE = new Map<SessionId, never>()
const EMPTY_LINEAGE_SNAPSHOT = (): typeof EMPTY_LINEAGE => EMPTY_LINEAGE
const EMPTY_COLLAPSED: ReadonlySet<string> = new Set()
const EMPTY_BRANCHES: ReadonlyMap<SessionId, SessionGraphBranch> = new Map()
const EMPTY_BRANCH_OFFS: readonly SessionGraphBranchOff[] = []
const NOOP_BRANCH_OFF = (_off: SessionGraphBranchOff): void => {}

interface GraphRow {
  readonly node: TreeNode
  readonly lane: number
  readonly parentLane: number | null
  readonly continues: readonly number[]
  readonly splitLanes?: readonly number[]
  readonly activeLanes?: readonly number[]
  /** Branch color of the node's dot; the neutral trunk color when absent. */
  readonly color?: number
}

/** Conversation-only mode survives reloads; storage failures fall back to showing everything. */
function readConversationOnly(): boolean {
  try {
    return typeof localStorage === 'object' && localStorage !== null
      && localStorage.getItem(CONVERSATION_ONLY_STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function writeConversationOnly(value: boolean): void {
  try {
    if (typeof localStorage === 'object' && localStorage !== null) {
      localStorage.setItem(CONVERSATION_ONLY_STORAGE_KEY, value ? '1' : '0')
    }
  } catch {
    // Without storage the choice lasts until the panel unmounts.
  }
}

/** Flatten the topology once. Lanes are bounded and reused; depth never becomes padding. */
function graphRows(nodes: readonly TreeNode[]): GraphRow[] {
  const children = new Map<string | null, TreeNode[]>()
  for (const node of nodes) {
    const siblings = children.get(node.parentId)
    if (siblings === undefined) children.set(node.parentId, [node])
    else siblings.push(node)
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.nodeId.localeCompare(b.nodeId))
  }
  const rows: GraphRow[] = []
  // Explicit pre-order stack: a long conversation is too deep for recursion.
  // Each node is emitted once, which also breaks parent-link cycles.
  const visited = new Set<TreeNode>()
  const stack: Array<{ readonly node: TreeNode; readonly lane: number; readonly parentLane: number | null }> = []
  const pushChildren = (parentId: string | null, parentLane: number | null, lane: number): void => {
    const siblings = children.get(parentId) ?? []
    for (let index = siblings.length - 1; index >= 0; index--) {
      const nodeLane = parentId === null ? 0 : index === 0 ? lane : (lane + index) % GRAPH_LANES
      stack.push({ node: siblings[index]!, lane: nodeLane, parentLane })
    }
  }
  pushChildren(null, null, 0)
  while (stack.length > 0) {
    const { node, lane, parentLane } = stack.pop()!
    if (visited.has(node)) continue
    visited.add(node)
    rows.push({ node, lane, parentLane, continues: parentLane === null ? [] : [parentLane] })
    pushChildren(node.nodeId, lane, lane)
  }
  return rows
}

/** Whether one node is a typed human prompt the fork selector may target. */
function isUserPromptNode(node: TreeNode): boolean {
  return node.message?.role === 'user' && !isInjectedUserNode(node)
}

/**
 * Remove hidden entries while preserving the visible tree topology: children
 * of a removed node reconnect to its nearest visible ancestor. The default
 * predicate drops harness-injected context; the fork selector passes its
 * prompts-only predicate so a prompt whose answer parent is filtered out
 * still hangs off the previous prompt instead of becoming unreachable.
 * @param countHidden - hidden entries to tally on their nearest visible ancestor.
 */
function projectVisibleNodes(
  nodes: readonly TreeNode[],
  isVisible: (node: TreeNode) => boolean = node => !isInjectedUserNode(node),
  countHidden?: (node: TreeNode) => boolean,
): readonly TreeNode[] {
  if (nodes.every(isVisible)) return nodes
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const visibleIds = new Set(nodes.filter(isVisible).map(node => node.nodeId))
  // Hidden runs can be thousands of entries long; each hidden id remembers
  // its visible ancestor so every walk stays linear.
  const anchors = new Map<string, string | null>()
  const resolveParent = (node: TreeNode): string | null => {
    const seen = new Set<string>()
    let parentId = node.parentId
    let anchor: string | null = null
    while (parentId !== null && !seen.has(parentId)) {
      if (visibleIds.has(parentId)) { anchor = parentId; break }
      const known = anchors.get(parentId)
      if (known !== undefined) { anchor = known; break }
      seen.add(parentId)
      parentId = byId.get(parentId)?.parentId ?? null
    }
    for (const id of seen) anchors.set(id, anchor)
    return anchor
  }
  const hiddenCounts = new Map<string, number>()
  if (countHidden !== undefined) {
    for (const node of nodes) {
      if (visibleIds.has(node.nodeId) || !countHidden(node)) continue
      const anchor = resolveParent(node)
      if (anchor !== null) hiddenCounts.set(anchor, (hiddenCounts.get(anchor) ?? 0) + 1)
    }
  }
  return nodes.filter(isVisible).map(node => {
    const parentId = node.parentId === null ? null : resolveParent(node)
    const hidden = hiddenCounts.get(node.nodeId)
    if (parentId === node.parentId && hidden === undefined) return node
    return {
      ...node,
      parentId,
      ...(hidden === undefined ? {} : { metadata: { ...node.metadata, [HIDDEN_TOOLS_KEY]: hidden } }),
    }
  })
}

/**
 * Project one Session view without mutating the payload returned by load().
 * The cursor, selection, and branch heads often rest on a hidden entry (a
 * tool call in conversation-only mode); each moves to its nearest visible
 * ancestor so the selected row and the fork anchor stay on the projected tree.
 */
function projectVisibleView(
  view: SessionTreeView,
  isVisible?: (node: TreeNode) => boolean,
  countHidden?: (node: TreeNode) => boolean,
): SessionTreeView {
  const nodes = projectVisibleNodes(view.nodes, isVisible, countHidden)
  if (nodes === view.nodes) return view
  const nodeIds = new Set(nodes.map(node => node.nodeId))
  const byId = new Map(view.nodes.map(node => [node.nodeId, node]))
  const nearestVisible = (nodeId: string): string | null => {
    const seen = new Set<string>()
    for (let current: string | null = nodeId; current !== null && !seen.has(current); current = byId.get(current)?.parentId ?? null) {
      if (nodeIds.has(current)) return current
      seen.add(current)
    }
    return null
  }
  const branchHeads = view.branchHeads === undefined ? undefined : Object.fromEntries(
    Object.entries(view.branchHeads).flatMap(([name, nodeId]) => {
      const visible = nearestVisible(nodeId)
      return visible === null ? [] : [[name, visible] as const]
    }),
  )
  return {
    ...view,
    cursor: view.cursor === null ? null : nearestVisible(view.cursor),
    ...(typeof view.selectedNodeId === 'string' ? { selectedNodeId: nearestVisible(view.selectedNodeId) } : {}),
    ...(branchHeads === undefined ? {} : { branchHeads }),
    nodes,
    branches: view.branches.map(branch => ({
      ...branch,
      nodeIds: branch.nodeIds.filter(nodeId => nodeIds.has(nodeId)),
    })),
  }
}

function placeholderKey(kind: SessionGraphPlaceholder): SessionTreeKey {
  return kind === 'error'
    ? 'panel.graph.error'
    : kind === 'empty'
      ? 'panel.graph.empty'
      : 'panel.graph.loading'
}

/** The tool name carried by a tool-call node, used as the role label before its result lands. */
function toolNameOf(node: TreeNode): string | undefined {
  for (const part of node.content ?? []) {
    if (part.type === 'tool_call') return part.name
  }
  return undefined
}

/** Whether one node is a tool interaction entry (call, result, or merged pair). */
function isToolNode(node: TreeNode): boolean {
  return node.type === 'tool_call' || node.type === 'tool_result' || node.message?.role === 'tool'
}

/** Whether a node records a failed call — the row is marked red. */
function nodeHasError(node: TreeNode): boolean {
  return node.error !== undefined
    || node.content?.some(part => part.type === 'tool_result' && part.isError === true) === true
}

/** Fixed-width IDEA-style graph gutter shared by legacy and merged modes. */
/**
 * The row's graph gutter. The node and its edges sit in a fixed 38px head;
 * a tail stretched over the rest of a taller row extends every lane that
 * continues downward, so lanes stay connected whatever the row height.
 * @param drawDown - whether this node's children are shown below it.
 */
function Graph({
  row,
  selected,
  onActivePath,
  drawDown,
}: {
  row: GraphRow
  selected: boolean
  onActivePath: boolean
  drawDown: boolean
}) {
  const x = LANE_X[row.lane] ?? LANE_X[0]
  const px = row.parentLane === null ? x : LANE_X[row.parentLane] ?? LANE_X[0]
  const edgeClass = [css.edge, onActivePath ? css.edgeActive : undefined].filter(Boolean).join(' ')
  const activeLanes = new Set(row.activeLanes ?? (onActivePath ? row.continues : []))
  const laneClass = (lane: number): string =>
    [css.rail, activeLanes.has(lane) ? css.railActive : undefined].filter(Boolean).join(' ')
  const splits = drawDown ? row.splitLanes ?? [] : []
  const tail = [
    ...row.continues.map(lane => ({ lane, className: laneClass(lane) })),
    ...(drawDown ? [{ lane: row.lane, className: edgeClass }] : []),
    ...splits.map(lane => ({ lane, className: laneClass(lane) })),
  ]
  const entry = row.parentLane === null ? `M ${x} 19` : `M ${px} 0 V 9 Q ${px} 19 ${x} 19`
  const dotClass = selected
    ? css.dotActive
    : [css.dot, row.color === undefined ? undefined : branchColorClass(row.color)].filter(Boolean).join(' ')
  return (
    <span className={css.graphCell} aria-hidden="true">
      <svg className={css.graph} viewBox="0 0 44 38">
        {row.continues.map(lane => (
          <path key={lane} className={laneClass(lane)} d={`M ${LANE_X[lane]} 0 V 38`} />
        ))}
        <path className={edgeClass} d={drawDown ? `${entry} V 38` : entry} />
        {splits.map(lane => (
          <path key={`split-${lane}`} className={laneClass(lane)} d={`M ${x} 19 Q ${LANE_X[lane]} 19 ${LANE_X[lane]} 38`} />
        ))}
        <circle className={dotClass} cx={x} cy="19" r={selected ? 5 : 4} />
        <circle className={css.dotCore} cx={x} cy="19" r="1.5" />
      </svg>
      <svg className={css.graphTail} viewBox="0 0 44 1" preserveAspectRatio="none">
        {tail.map(({ lane, className }, index) => (
          <path key={index} className={className} d={`M ${LANE_X[lane]} 0 V 1`} />
        ))}
      </svg>
    </span>
  )
}

function badgeText(badge: SessionGraphBadge, t: (key: SessionTreeKey) => string): string {
  return badge.kind === 'main'
    ? t('branch.tree.main')
    : badge.kind === 'fork'
      ? t('branch.node.forkBadge')
      : t('branch.tree.cloneBadge')
}

function badgeClass(badge: SessionGraphBadge): string | undefined {
  return badge.kind === 'main'
    ? css.mainBadge
    : badge.kind === 'fork'
      ? css.forkBadge
      : css.cloneBadge
}

function PlaceholderText({
  kind,
  t,
}: {
  kind: SessionGraphPlaceholder
  t: (key: SessionTreeKey) => string
}) {
  return <>{t(placeholderKey(kind))}</>
}

/**
 * One render-ready row. Badge controls live in a separate content wrapper
 * above the node-selection button so controls never nest inside each other.
 * Memoized: a graph has thousands of rows and most props are stable.
 */
const NodeRow = memo(function NodeRow({
  rowKey,
  node,
  lane,
  parentLane,
  continues,
  splitLanes,
  activeLanes,
  owners,
  badges,
  placeholder,
  selected,
  onActivePath,
  branchHeads,
  hasChildren,
  expanded,
  messageOpen,
  selectorMode,
  pending,
  showFork,
  branchCollapsed,
  bodyOnly = false,
  color,
  branchOffs = EMPTY_BRANCH_OFFS,
  branchById = EMPTY_BRANCHES,
  focusMode = false,
  flash = false,
  onToggleNode,
  onToggleBranch,
  onSelect,
  onFork,
  onForkUserPrompt,
  onBranchOff = NOOP_BRANCH_OFF,
  t,
}: {
  rowKey: string
  node: TreeNode
  lane: number
  parentLane: number | null
  continues: readonly number[]
  splitLanes?: readonly number[]
  activeLanes?: readonly number[]
  /** Branch color of the Session the entry originates from. */
  color?: number
  /** Show only the message body: no reasoning, no tool-call text. */
  bodyOnly?: boolean
  branchOffs?: readonly SessionGraphBranchOff[]
  branchById?: ReadonlyMap<SessionId, SessionGraphBranch>
  /** Branch-offs switch the focus instead of scrolling to the branch. */
  focusMode?: boolean
  flash?: boolean
  owners: readonly SessionId[]
  badges: readonly SessionGraphBadge[]
  placeholder: SessionGraphPlaceholder | undefined
  selected: boolean
  onActivePath: boolean
  branchHeads: Record<string, string> | undefined
  hasChildren: boolean
  expanded: boolean
  messageOpen: boolean
  selectorMode: boolean
  pending: boolean
  showFork: boolean
  branchCollapsed: ReadonlySet<string>
  onToggleNode: (key: string) => void
  onToggleBranch: (key: string) => void
  onSelect: (rowKey: string, node: TreeNode) => void
  onFork: (node: TreeNode) => void
  onForkUserPrompt: (node: TreeNode) => void
  onBranchOff?: (off: SessionGraphBranchOff) => void
  t: (key: SessionTreeKey) => string
}) {
  const heads = Object.entries(branchHeads ?? {})
    .filter(([, id]) => id === node.nodeId)
    .map(([name]) => name)
  const hiddenTools = bodyOnly ? node.metadata?.[HIDDEN_TOOLS_KEY] : undefined
  const failed = nodeHasError(node) || placeholder === 'error'
  const kindClass = failed
    ? css.nodeError
    : isToolNode(node)
      ? css.nodeTool
      : placeholder !== undefined
        ? css.nodePlaceholder
        : undefined
  const classes = [
    css.node,
    selected ? css.nodeSelected : onActivePath ? css.nodePath : undefined,
    messageOpen ? css.nodeMessageOpen : undefined,
    flash ? css.nodeFlash : undefined,
    kindClass,
  ].filter(Boolean).join(' ')
  const role = node.message === undefined
    ? toolNameOf(node) ?? t('node.noMessage')
    : t(ROLE_LABELS[node.message.role])
  const fullText = bodyOnly ? nodeBodyText(node) || node.error || nodeFullText(node) : nodeFullText(node)
  const toggleLabel = expanded ? t('node.collapse') : t('node.expand')
  const primaryOwner = owners.at(-1) ?? owners[0]

  return (
    <div
      className={classes}
      data-node-id={node.nodeId}
      data-session-tree-row={rowKey}
      data-session-owners={owners.join(' ')}
      data-session-owner={primaryOwner}
      data-placeholder={placeholder}
    >
      {hasChildren ? (
        <button
          type="button"
          className={css.expander}
          aria-expanded={expanded}
          aria-label={`${toggleLabel} — ${node.summary}`}
          title={toggleLabel}
          onClick={() => { onToggleNode(rowKey) }}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span className={css.expanderPlaceholder} aria-hidden="true" />
      )}
      <Graph
        row={{
          node, lane, parentLane, continues,
          ...(splitLanes === undefined ? {} : { splitLanes }),
          ...(activeLanes === undefined ? {} : { activeLanes }),
          ...(color === undefined ? {} : { color }),
        }}
        selected={selected}
        onActivePath={onActivePath}
        drawDown={hasChildren && expanded}
      />
      <div className={css.nodeContent}>
        {badges.map(badge => {
          const branchExpanded = !branchCollapsed.has(badge.collapseKey)
          const branchToggleLabel = branchExpanded ? t('branch.tree.collapse') : t('branch.tree.expand')
          const badgeColor = branchById.get(badge.sessionId)?.color
          const badgeContents = (
            <>
              {badgeColor === undefined ? null : (
                <span className={[css.swatch, branchColorClass(badgeColor)].filter(Boolean).join(' ')} aria-hidden="true" />
              )}
              <span className={badgeClass(badge)}>{badgeText(badge, t)}</span>
              {badge.branchLabel === undefined ? null : <span className={css.branchChip}>{badge.branchLabel}</span>}
              {badgeColor === undefined ? null : <span className={css.badgeTitle}>{badge.title}</span>}
              {badge.current ? <span className={css.currentChip}>{t('branch.tree.current')}</span> : null}
              {badge.running ? <span className={css.runningDot} /> : null}
            </>
          )
          return (
            <div className={css.branchBadgeLine} key={`${badge.sessionId}:${badge.collapseKey}`}>
              {badge.hasChildren ? (
                <button
                  type="button"
                  className={css.branchBadgeButton}
                  aria-expanded={branchExpanded}
                  aria-label={`${branchToggleLabel} — ${badge.title}`}
                  title={branchToggleLabel}
                  onClick={() => { onToggleBranch(badge.collapseKey) }}
                >
                  {badgeContents}
                </button>
              ) : (
                <span className={css.branchBadgeStatic}>{badgeContents}</span>
              )}
            </div>
          )
        })}
        <button
          type="button"
          className={css.select}
          disabled={pending || placeholder !== undefined}
          aria-pressed={selectorMode ? undefined : selected}
          aria-label={`${selectorMode ? t('fork.selector.select') : t('panel.select')} — ${node.summary}`}
          title={`${selectorMode ? t('fork.selector.select') : t('panel.select')} — ${node.nodeId}`}
          onClick={() => {
            if (selectorMode) onForkUserPrompt(node)
            else onSelect(rowKey, node)
          }}
        >
          <span className={css.nodeTopline}>
            <span className={css.role}>{role}</span>
            <span className={css.branch}>{node.branch}</span>
            {heads.length > 0 ? <span className={css.head}>{heads.join(', ')}</span> : null}
            {typeof hiddenTools === 'number' ? (
              <span className={css.hiddenTools}>{t('node.hiddenTools').replace('{n}', String(hiddenTools))}</span>
            ) : null}
          </span>
          <span className={css.summary}>
            {placeholder === undefined ? fullText : <PlaceholderText kind={placeholder} t={t} />}
          </span>
        </button>
        {branchOffs.length === 0 ? null : (
          <div className={css.branchOffLine}>
            <span className={css.branchOffLabel}>⑂ {t('branch.off.title')}</span>
            {branchOffs.map(off => {
              const branch = branchById.get(off.sessionId)
              if (branch === undefined) return null
              const action = focusMode ? t('branch.off.focus') : t('branch.off.jump')
              return (
                <button
                  key={off.sessionId}
                  type="button"
                  className={css.branchOffChip}
                  aria-label={`${action} — ${branch.title}`}
                  title={action}
                  onClick={() => { onBranchOff(off) }}
                >
                  <span className={[css.swatch, branchColorClass(branch.color)].filter(Boolean).join(' ')} aria-hidden="true" />
                  <span className={css.branchOffTitle}>{branch.title}</span>
                </button>
              )
            })}
          </div>
        )}
      </div>
      {showFork ? (
        <button
          type="button"
          className={css.forkAction}
          disabled={pending || selectorMode}
          title={t('panel.fork')}
          aria-label={`${t('panel.fork')} — ${node.nodeId}`}
          onClick={() => { onFork(node) }}
        >
          ⑂
        </button>
      ) : <span className={css.forkActionPlaceholder} aria-hidden="true" />}
    </div>
  )
})

function PanelHeader({
  title,
  branchCount,
  nodeCount,
  pending,
  onRefresh,
  onClose,
  controls,
  t,
}: {
  title: string
  branchCount: number
  nodeCount: number
  pending: boolean
  onRefresh: () => void
  onClose?: () => void
  /** View controls placed before Refresh. */
  controls?: ReactNode
  t: (key: SessionTreeKey) => string
}) {
  return (
    <header className={css.header}>
      <div className={css.heading}>
        <span className={css.title}>{title}</span>
        <span className={css.stats}>{branchCount} {t('panel.branch')} · {nodeCount} {t('panel.nodes')}</span>
      </div>
      <div className={css.headerActions}>
        {controls}
        <button type="button" className={css.refresh} disabled={pending} onClick={onRefresh}>
          {t('panel.refresh')}
        </button>
        {onClose === undefined ? null : (
          <button type="button" className={css.close} aria-label={t('panel.close')} onClick={onClose}>×</button>
        )}
      </div>
    </header>
  )
}

/** Two-way switch between the conversation-only projection and every entry. */
function ViewModeToggle({
  conversationOnly,
  onChange,
  t,
}: {
  conversationOnly: boolean
  onChange: (conversationOnly: boolean) => void
  t: (key: SessionTreeKey) => string
}) {
  return (
    <div className={css.modeToggle} role="group" aria-label={t('panel.mode.label')}>
      <button
        type="button"
        className={css.modeOption}
        aria-pressed={conversationOnly}
        title={t('panel.mode.conversationHint')}
        onClick={() => { onChange(true) }}
      >
        {t('panel.mode.conversation')}
      </button>
      <button
        type="button"
        className={css.modeOption}
        aria-pressed={!conversationOnly}
        title={t('panel.mode.allHint')}
        onClick={() => { onChange(false) }}
      >
        {t('panel.mode.all')}
      </button>
    </div>
  )
}

/** Header chip naming the focused branch, with the way back to every branch. */
function FocusChip({
  branch,
  onClear,
  t,
}: {
  branch: SessionGraphBranch
  onClear: () => void
  t: (key: SessionTreeKey) => string
}) {
  return (
    <span className={css.focusChip} title={`${t('branch.focus.viewing')}: ${branch.title}`}>
      <span className={[css.swatch, branchColorClass(branch.color)].filter(Boolean).join(' ')} aria-hidden="true" />
      <span className={css.focusTitle}>{branch.title}</span>
      <button
        type="button"
        className={css.focusClear}
        aria-label={t('branch.focus.clear')}
        title={t('branch.focus.clear')}
        onClick={onClear}
      >
        ×
      </button>
    </span>
  )
}

/** Find one rendered graph row by its key without building a selector from it. */
function findRow(container: HTMLElement | null, key: string): HTMLElement | undefined {
  return [...(container?.querySelectorAll<HTMLElement>('[data-session-tree-row]') ?? [])]
    .find(element => element.dataset.sessionTreeRow === key)
}

/** A row's viewport offset, restored after the graph re-lays out under it. */
interface ViewportAnchor {
  /** The row, then its ancestors: a row the new layout drops falls back to the nearest kept one. */
  readonly keys: readonly string[]
  readonly top: number
}

/** The first row below the panel header, with its ancestor chain from `rows`. */
function captureViewportAnchor(body: HTMLElement | null, rows: readonly SessionGraphRow[]): ViewportAnchor | null {
  if (body === null) return null
  const header = body.parentElement?.querySelector('header')
  const limit = Math.max(body.getBoundingClientRect().top, header?.getBoundingClientRect().bottom ?? -Infinity)
  // Scan row groups first: measuring every row would lay out the skipped ones.
  const chunk = [...body.children].find(child => child.getBoundingClientRect().bottom > limit)
  const row = [...(chunk?.querySelectorAll<HTMLElement>('[data-session-tree-row]') ?? [])]
    .find(element => element.getBoundingClientRect().bottom > limit)
  const key = row?.dataset.sessionTreeRow
  if (row === undefined || key === undefined) return null
  const parents = new Map(rows.map(entry => [entry.key, entry.parentKey]))
  const keys = new Set<string>()
  for (let current: string | null | undefined = key; typeof current === 'string' && !keys.has(current); current = parents.get(current)) {
    keys.add(current)
  }
  return { keys: [...keys], top: row.getBoundingClientRect().top }
}

function scrollParentOf(element: HTMLElement): Element | null {
  for (let current = element.parentElement; current !== null; current = current.parentElement) {
    const overflow = getComputedStyle(current).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && current.scrollHeight > current.clientHeight) return current
  }
  return document.scrollingElement
}

/**
 * Per-Session single-flight tree reads. A request for a Session that is
 * already loading becomes one trailing reread, and every settled answer is
 * committed, so a busy session list can neither stack full tree reads nor
 * discard answers that already arrived.
 * @param load - reads one Session's complete tree view.
 * @returns loaded views, failed Sessions, a delayed coalescing scheduler, and an immediate reload.
 */
function useSessionViewLoader(load: (sessionId: SessionId) => Promise<SessionTreeView>) {
  const [views, setViews] = useState<ReadonlyMap<SessionId, SessionTreeView>>(() => new Map())
  const [failed, setFailed] = useState<ReadonlySet<SessionId>>(() => new Set())
  const loadRef = useRef(load)
  loadRef.current = load
  const inFlight = useRef(new Set<SessionId>())
  const trailing = useRef(new Set<SessionId>())
  const timers = useRef(new Map<SessionId, number>())
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    const pending = timers.current
    return () => {
      mounted.current = false
      for (const timer of pending.values()) window.clearTimeout(timer)
      pending.clear()
    }
  }, [])

  const fetchNow = useCallback((id: SessionId): void => {
    if (inFlight.current.has(id)) {
      trailing.current.add(id)
      return
    }
    inFlight.current.add(id)
    void loadRef.current(id).then(
      view => {
        if (!mounted.current) return
        setViews(current => new Map(current).set(id, view))
        setFailed(current => {
          if (!current.has(id)) return current
          const next = new Set(current)
          next.delete(id)
          return next
        })
      },
      () => {
        if (!mounted.current) return
        setFailed(current => current.has(id) ? current : new Set(current).add(id))
      },
    ).finally(() => {
      inFlight.current.delete(id)
      if (trailing.current.delete(id) && mounted.current) fetchNow(id)
    })
  }, [])

  /** Read each Session after `delayMs`; a read already scheduled absorbs the request. */
  const schedule = useCallback((ids: readonly SessionId[], delayMs: number): void => {
    for (const id of ids) {
      if (timers.current.has(id)) continue
      timers.current.set(id, window.setTimeout(() => {
        timers.current.delete(id)
        fetchNow(id)
      }, delayMs))
    }
  }, [fetchNow])

  const reload = useCallback((ids: readonly SessionId[]): void => {
    for (const id of ids) {
      const timer = timers.current.get(id)
      if (timer !== undefined) {
        window.clearTimeout(timer)
        timers.current.delete(id)
      }
      fetchNow(id)
    }
  }, [fetchNow])

  return { views, failed, schedule, reload }
}

type MergedSessionTreePanelProps = SessionTreeViewProps & PropsLocale<'session-tree'> & {
  readonly useSessions: NonNullable<SessionTreeViewProps['useSessions']>
  readonly openSession: NonNullable<SessionTreeViewProps['openSession']>
  readonly jumpSession: NonNullable<SessionTreeViewProps['jumpSession']>
}

function MergedSessionTreePanel({
  closeDetails,
  sessionId,
  load,
  jump,
  jumpSession,
  select,
  fork,
  forkUserPrompt,
  onRefresh,
  useSessions,
  openSession,
  onForkCompleted,
  lineage,
  t,
}: MergedSessionTreePanelProps) {
  const entries = useSyncExternalStore(
    lineage?.subscribe ?? NOOP_SUBSCRIBE,
    lineage?.getSnapshot ?? EMPTY_LINEAGE_SNAPSHOT,
    lineage?.getSnapshot ?? EMPTY_LINEAGE_SNAPSHOT,
  )
  // Any running Session replaces the list snapshot. Keep the previous one
  // until something this graph reads changes, so unrelated traffic neither
  // rebuilds the graph nor re-renders its rows.
  const listCache = useRef<{ readonly signature: string; readonly state: SessionListState } | null>(null)
  const listState = useSessions(state => {
    const signature = lineageSignature(sessionId, state, entries)
    if (listCache.current?.signature !== signature) listCache.current = { signature, state }
    return listCache.current.state
  })
  const { views, failed, schedule, reload } = useSessionViewLoader(load)
  const [nodeCollapsed, setNodeCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [branchCollapsed, setBranchCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(() => new Set())
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conversationOnly, setConversationOnly] = useState(readConversationOnly)
  const [focusId, setFocusId] = useState<SessionId | null>(null)
  const [overviewOpen, setOverviewOpen] = useState(true)
  const [pendingReveal, setPendingReveal] = useState<string | null>(null)
  const [scrollTarget, setScrollTarget] = useState<string | null>(null)
  const [flashKey, setFlashKey] = useState<string | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  const topology = useMemo(
    () => buildBranchTreeModel(sessionId, listState, entries),
    [sessionId, listState, entries],
  )
  const projectedViews = useMemo(
    () => new Map([...views].map(([id, view]) => [id, conversationOnly
      ? projectVisibleView(view, isConversationNode, isToolNode)
      : projectVisibleView(view)])),
    [conversationOnly, views],
  )
  const model = useMemo(
    () => topology === null ? null : buildSessionGraphModel(topology, projectedViews, failed, focusId ?? undefined),
    [focusId, topology, projectedViews, failed],
  )
  const branchById = useMemo(
    () => new Map((model?.branches ?? []).map(branch => [branch.sessionId, branch])),
    [model],
  )
  const focusedBranch = model?.focusSessionId === undefined ? undefined : branchById.get(model.focusSessionId)

  // The whole session list changes whenever any Session runs; only the
  // lineage's own rows may trigger tree reads, one Session at a time.
  const revisions = useMemo(
    () => topology === null ? null : lineageRevisions(listState, topology.rows.map(row => row.sessionId)),
    [listState, topology],
  )
  const requestedRevisions = useRef(new Map<SessionId, string>())
  useEffect(() => {
    if (revisions === null) return
    const added: SessionId[] = []
    const changed: SessionId[] = []
    for (const [id, revision] of revisions) {
      const requested = requestedRevisions.current.get(id)
      if (requested === revision) continue
      requestedRevisions.current.set(id, revision)
      if (requested === undefined) added.push(id)
      else changed.push(id)
    }
    schedule(added, FAN_OUT_DEBOUNCE_MS)
    schedule(changed, REVISION_REFRESH_MS)
  }, [revisions, schedule])

  useEffect(() => onRefresh?.(() => {
    if (topology === null) return
    reload(topology.rows.map(row => row.sessionId))
  }), [onRefresh, reload, topology])

  // A newly arrived Session/branch starts expanded. Collapse state is a view
  // preference, so it is safe to reset when the graph gains new topology.
  const previousSessionKey = useRef<string | null>(null)
  useEffect(() => {
    if (model === null) return
    const nextKey = model.sessionIds.join('\u0000')
    const previous = previousSessionKey.current
    previousSessionKey.current = nextKey
    if (previous === null || previous === nextKey) return
    const previousIds = new Set(previous === '' ? [] : previous.split('\u0000'))
    if (!model.sessionIds.some(id => !previousIds.has(id))) return
    setNodeCollapsed(new Set())
    setBranchCollapsed(new Set())
  }, [model])

  const previousLineageSize = useRef(entries.size)
  useEffect(() => {
    const previous = previousLineageSize.current
    previousLineageSize.current = entries.size
    if (entries.size <= previous) return
    setNodeCollapsed(new Set())
    setBranchCollapsed(new Set())
  }, [entries])

  // Switching the open Session reveals its ancestor branches without user
  // action, so the new active path is always visible.
  const previousHighlighted = useRef<SessionId | undefined>(undefined)
  useEffect(() => {
    if (model === null) return
    const previous = previousHighlighted.current
    previousHighlighted.current = model.highlightedId
    if (previous === undefined || previous === model.highlightedId) return
    setBranchCollapsed(current => {
      const next = new Set(current)
      let changed = false
      for (const key of model.activeBranchKeys) {
        if (next.delete(key)) changed = true
      }
      return changed ? next : current
    })
    setNodeCollapsed(current => {
      const next = new Set(current)
      let changed = false
      for (const key of model.activePathKeys) {
        if (next.delete(key)) changed = true
      }
      return changed ? next : current
    })
  }, [model])

  const toggleNode = useCallback((key: string): void => {
    setNodeCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])
  const toggleBranch = useCallback((key: string): void => {
    setBranchCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // Switching modes or clearing the focus re-lays out the whole graph; the
  // row at the top of the view (or its nearest kept ancestor) stays in place.
  const viewportAnchor = useRef<ViewportAnchor | null>(null)
  useLayoutEffect(() => {
    const anchor = viewportAnchor.current
    if (anchor === null || model === null) return
    viewportAnchor.current = null
    const present = new Set(model.rows.map(row => row.key))
    const key = anchor.keys.find(candidate => present.has(candidate))
    const row = key === undefined ? undefined : findRow(bodyRef.current, key)
    if (row === undefined) return
    const align = (): void => { scrollParentOf(row)?.scrollBy?.(0, row.getBoundingClientRect().top - anchor.top) }
    align()
    // Row groups laid out for the first time by that scroll can shift the row once more.
    const frame = window.requestAnimationFrame(align)
    return () => { window.cancelAnimationFrame(frame) }
  }, [model])

  const chooseConversationOnly = useCallback((value: boolean): void => {
    if (value === conversationOnly) return
    viewportAnchor.current = model === null ? null : captureViewportAnchor(bodyRef.current, model.rows)
    setConversationOnly(value)
    writeConversationOnly(value)
  }, [conversationOnly, model])

  // A Session that left the lineage cannot stay focused.
  useEffect(() => {
    if (focusId !== null && model !== null && model.focusSessionId === undefined) setFocusId(null)
  }, [focusId, model])

  const handleOverviewFocus = useCallback((id: SessionId | null): void => {
    if (id === null) {
      if (focusId === null) return
      viewportAnchor.current = model === null ? null : captureViewportAnchor(bodyRef.current, model.rows)
    }
    setFocusId(id)
    const startKey = id === null ? undefined : branchById.get(id)?.startKey
    if (startKey !== undefined) setPendingReveal(startKey)
  }, [branchById, focusId, model])
  const handleBranchOff = useCallback((off: SessionGraphBranchOff): void => {
    if (model?.focusSessionId !== undefined) setFocusId(off.sessionId)
    setPendingReveal(off.key)
  }, [model])

  // Reveal once the model for the new focus exists: expand whatever hides the
  // row, then scroll to it and flash it after it renders.
  useEffect(() => {
    if (pendingReveal === null || model === null) return
    setPendingReveal(null)
    const byKey = new Map(model.rows.map(row => [row.key, row]))
    const target = byKey.get(pendingReveal)
    if (target === undefined) return
    const ancestors = new Set<string>()
    for (let key = target.parentKey; key !== null && !ancestors.has(key); key = byKey.get(key)?.parentKey ?? null) {
      ancestors.add(key)
    }
    setNodeCollapsed(current => [...ancestors].some(key => current.has(key))
      ? new Set([...current].filter(key => !ancestors.has(key)))
      : current)
    setBranchCollapsed(current => target.branchKeys.some(key => current.has(key))
      ? new Set([...current].filter(key => !target.branchKeys.includes(key)))
      : current)
    setScrollTarget(target.key)
    setFlashKey(target.key)
  }, [model, pendingReveal])

  useEffect(() => {
    if (scrollTarget === null) return
    setScrollTarget(null)
    findRow(bodyRef.current, scrollTarget)?.scrollIntoView?.({ block: 'center' })
  }, [scrollTarget])

  useEffect(() => {
    if (flashKey === null) return
    const timer = window.setTimeout(() => { setFlashKey(null) }, FLASH_MS)
    return () => { window.clearTimeout(timer) }
  }, [flashKey])

  const visibleChunks = useMemo(() => {
    const chunks: Array<{ readonly id: number; readonly rows: SessionGraphRow[] }> = []
    if (model === null) return chunks
    // Rows arrive in pre-order, so a row is under a collapsed node exactly
    // when its parent is collapsed or itself under one: one linear pass.
    const underCollapsed = new Set<string>()
    model.rows.forEach((row, index) => {
      const parentKey = row.parentKey
      if (parentKey !== null && (nodeCollapsed.has(parentKey) || underCollapsed.has(parentKey))) {
        underCollapsed.add(row.key)
        return
      }
      for (const collapseKey of branchCollapsed) {
        const keepsBranchAnchorVisible = row.badges.some(badge => badge.collapseKey === collapseKey)
        if (!keepsBranchAnchorVisible && row.branchKeys.includes(collapseKey)) return
      }
      // Chunks follow model position rather than visible position, so
      // collapsing never moves (and remounts) the rows that stay visible.
      const id = Math.floor(index / ROW_CHUNK_SIZE)
      const last = chunks.at(-1)
      if (last?.id === id) last.rows.push(row)
      else chunks.push({ id, rows: [row] })
    })
    return chunks
  }, [branchCollapsed, model, nodeCollapsed])

  const reloadCurrent = useCallback((): void => {
    if (model === null) return
    reload(model.sessionIds)
  }, [model, reload])

  const handleSelect = useCallback(async (rowKey: string, node: TreeNode): Promise<void> => {
    if (pending || node.nodeId.startsWith('__session-tree-')) return
    setExpandedMessages(current => {
      const next = new Set(current)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
      return next
    })
    if (model === null) return
    const row = model.rows.find(candidate => candidate.key === rowKey)
    if (row === undefined || row.placeholder !== undefined) return
    // A copied row belongs to every Session holding the copy: jump inside the
    // open Session when it holds the row, otherwise where the row was written.
    const targetSessionId = row.owners.includes(model.highlightedId)
      ? model.highlightedId
      : row.badges.at(-1)?.sessionId ?? row.owners[0]
    if (targetSessionId === undefined) return

    setPending(true)
    setError(null)
    try {
      if (targetSessionId === model.highlightedId) {
        if (select !== undefined) await select(node.nodeId)
        await jump(node.nodeId)
      } else {
        openSession(targetSessionId)
        await jumpSession(targetSessionId, node.nodeId)
      }
      reload([targetSessionId])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [jump, jumpSession, model, openSession, pending, reload, select])

  const handleFork = useCallback(async (node: TreeNode): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result: SessionTreeForkView = await fork(node.nodeId, `fork-${Date.now().toString(36)}`)
      onForkCompleted?.(result)
      reloadCurrent()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [fork, onForkCompleted, pending, reloadCurrent])

  const handleForkUserPrompt = useCallback(async (node: TreeNode): Promise<void> => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (forkUserPrompt === undefined) throw new Error('native fork action is unavailable')
      await forkUserPrompt(node)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [forkUserPrompt, pending])

  // Row handlers change with `pending`, the model, and slot-provided actions;
  // memoized rows receive stable wrappers that always call the latest ones.
  const rowHandlers = useRef({ handleSelect, handleFork, handleForkUserPrompt })
  rowHandlers.current = { handleSelect, handleFork, handleForkUserPrompt }
  const selectRow = useCallback((rowKey: string, node: TreeNode): void => {
    void rowHandlers.current.handleSelect(rowKey, node)
  }, [])
  const forkRow = useCallback((node: TreeNode): void => {
    void rowHandlers.current.handleFork(node)
  }, [])
  const forkRowPrompt = useCallback((node: TreeNode): void => {
    void rowHandlers.current.handleForkUserPrompt(node)
  }, [])

  if (model === null) return null
  const focusMode = model.focusSessionId !== undefined

  return (
    <section className={css.panel} aria-label={t('panel.title')}>
      <PanelHeader
        title={t('panel.title')}
        branchCount={model.sessionIds.length}
        nodeCount={model.rows.length}
        pending={pending}
        onRefresh={reloadCurrent}
        {...(closeDetails === undefined ? {} : { onClose: closeDetails })}
        controls={(
          <>
            {focusedBranch === undefined ? null : (
              <FocusChip branch={focusedBranch} onClear={() => { handleOverviewFocus(null) }} t={t} />
            )}
            <ViewModeToggle conversationOnly={conversationOnly} onChange={chooseConversationOnly} t={t} />
          </>
        )}
        t={t}
      />
      {model.branches.length > 1 ? (
        <BranchOverview
          branches={model.branches}
          focusSessionId={model.focusSessionId}
          expanded={overviewOpen}
          onToggle={() => { setOverviewOpen(open => !open) }}
          onFocus={handleOverviewFocus}
          onOpen={openSession}
          t={t}
        />
      ) : null}
      <div className={css.legend}><span className={css.legendDot} />{t('panel.selectedHint')}</div>
      <div
        ref={bodyRef}
        className={css.body}
        aria-busy={model.rows.some(row => row.placeholder === 'loading') || pending}
      >
        {error === null ? null : <p className={css.error}>{t('panel.error')}: {error}</p>}
        {model.rows.length === 0 ? <p className={css.empty}>{t('panel.empty')}</p> : null}
        {visibleChunks.map(chunk => (
          <div key={chunk.id} className={css.rowChunk}>
            {chunk.rows.map(row => (
              <NodeRow
                key={row.key}
                rowKey={row.key}
                node={row.node}
                lane={row.lane}
                parentLane={row.parentLane}
                continues={row.continues}
                splitLanes={row.splitLanes}
                activeLanes={row.activeLanes}
                owners={row.owners}
                badges={row.badges}
                placeholder={row.placeholder}
                selected={row.active}
                onActivePath={row.onActivePath}
                branchHeads={projectedViews.get(row.owners[0] ?? model.highlightedId)?.branchHeads}
                hasChildren={row.hasChildren}
                expanded={!nodeCollapsed.has(row.key)}
                messageOpen={expandedMessages.has(row.key)}
                selectorMode={false}
                pending={pending}
                showFork={row.placeholder === undefined && row.owners.includes(model.highlightedId)}
                branchCollapsed={row.badges.length > 0 ? branchCollapsed : EMPTY_COLLAPSED}
                bodyOnly={conversationOnly}
                color={row.color}
                branchOffs={row.branchOffs}
                branchById={branchById}
                focusMode={focusMode}
                flash={row.key === flashKey}
                onToggleNode={toggleNode}
                onToggleBranch={toggleBranch}
                onSelect={selectRow}
                onFork={forkRow}
                onForkUserPrompt={forkRowPrompt}
                onBranchOff={handleBranchOff}
                t={t}
              />
            ))}
          </div>
        ))}
      </div>
    </section>
  )
}

function LegacySessionTreePanel({
  closeDetails,
  sessionId,
  load,
  jump,
  select,
  fork,
  forkUserPrompt,
  onRefresh,
  useSessions,
  onForkCompleted,
  selectorMode,
  t,
}: SessionTreeViewProps & PropsLocale<'session-tree'> & { selectorMode: boolean }) {
  const [view, setView] = useState<SessionTreeView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [expandedMessages, setExpandedMessages] = useState<ReadonlySet<string>>(() => new Set<string>())

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setView(await load(sessionId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [load, sessionId])

  const sessionListRevision = useSessions?.(state => {
    const ids = Array.isArray(state.ids) ? state.ids : []
    const byId = state.byId ?? {}
    return [
      state.phase ?? '',
      currentSessionId(state) ?? '',
      ids.join('\n'),
      ids.map(id => {
        const row = byId[id]
        return row === undefined ? '' : [row.displayTitle, row.blank, row.running, row.updatedAt].join(':')
      }).join('\n'),
    ].join('|')
  })

  useEffect(() => {
    if (sessionListRevision !== undefined) return
    void refresh()
  }, [refresh, sessionListRevision])
  useEffect(() => onRefresh?.(() => { void refresh() }), [onRefresh, refresh])
  useEffect(() => {
    if (sessionListRevision === undefined) return
    void refresh()
  }, [refresh, sessionListRevision])

  const visibleNodes = useMemo(() => projectVisibleNodes(view?.nodes ?? []), [view?.nodes])
  const displayedNodes = useMemo(
    () => selectorMode ? projectVisibleNodes(visibleNodes, isUserPromptNode) : visibleNodes,
    [selectorMode, visibleNodes],
  )
  const rows = useMemo(() => graphRows(displayedNodes), [displayedNodes])
  const childIds = useMemo(() => {
    const children = new Map<string, string[]>()
    for (const node of displayedNodes) {
      const parentId = node.parentId
      if (parentId === null) continue
      const siblings = children.get(parentId)
      if (siblings === undefined) children.set(parentId, [node.nodeId])
      else siblings.push(node.nodeId)
    }
    return children
  }, [displayedNodes])

  const visibleRows = useMemo(() => {
    if (selectorMode) return rows
    // `graphRows` emits pre-order, so hiding propagates in one linear pass.
    const underCollapsed = new Set<string>()
    return rows.filter(({ node }) => {
      const parentId = node.parentId
      if (parentId !== null && (collapsed.has(parentId) || underCollapsed.has(parentId))) {
        underCollapsed.add(node.nodeId)
        return false
      }
      return true
    })
  }, [collapsed, rows, selectorMode])

  const panelTitle = selectorMode ? t('fork.selector.title') : t('panel.title')
  const handleSelect = useCallback(async (rowKey: string, node: TreeNode) => {
    if (selectorMode) {
      if (pending) return
      setPending(true)
      setError(null)
      try {
        if (forkUserPrompt === undefined) throw new Error('native fork action is unavailable')
        await forkUserPrompt(node)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setPending(false)
      }
      return
    }
    setExpandedMessages(current => {
      const next = new Set(current)
      if (next.has(rowKey)) next.delete(rowKey)
      else next.add(rowKey)
      return next
    })
    if (pending) return
    setPending(true)
    setError(null)
    try {
      if (select !== undefined) await select(node.nodeId)
      await jump(node.nodeId)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [forkUserPrompt, jump, pending, refresh, select, selectorMode])

  const handleFork = useCallback(async (node: TreeNode) => {
    if (pending) return
    setPending(true)
    setError(null)
    try {
      const result: SessionTreeForkView = await fork(node.nodeId, `fork-${Date.now().toString(36)}`)
      onForkCompleted?.(result)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(false)
    }
  }, [fork, onForkCompleted, pending, refresh])

  const toggleNode = useCallback((nodeId: string) => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(nodeId)) next.delete(nodeId)
      else next.add(nodeId)
      return next
    })
  }, [])

  return (
    <section className={css.panel} aria-label={panelTitle}>
      <PanelHeader
        title={panelTitle}
        branchCount={view?.branches.length ?? 0}
        nodeCount={displayedNodes.length}
        pending={pending}
        onRefresh={() => { void refresh() }}
        {...(closeDetails === undefined ? {} : { onClose: closeDetails })}
        t={t}
      />
      <div className={css.legend}><span className={css.legendDot} />{t('panel.selectedHint')}</div>
      <div className={css.body} aria-busy={pending}>
        {error === null ? null : <p className={css.error}>{t('panel.error')}: {error}</p>}
        {view !== null && (selectorMode ? displayedNodes.length === 0 : rows.length === 0)
          ? <p className={css.empty}>{selectorMode ? t('fork.selector.empty') : t('panel.empty')}</p>
          : null}
        {visibleRows.map(row => (
          <NodeRow
            key={row.node.nodeId}
            rowKey={row.node.nodeId}
            node={row.node}
            lane={row.lane}
            parentLane={row.parentLane}
            continues={row.continues}
            owners={[]}
            badges={[]}
            placeholder={undefined}
            selected={row.node.nodeId === view?.selectedNodeId}
            onActivePath={false}
            branchHeads={view?.branchHeads}
            hasChildren={(childIds.get(row.node.nodeId)?.length ?? 0) > 0}
            expanded={!collapsed.has(row.node.nodeId)}
            messageOpen={expandedMessages.has(row.node.nodeId)}
            selectorMode={selectorMode}
            pending={pending}
            showFork={!selectorMode}
            branchCollapsed={EMPTY_COLLAPSED}
            onToggleNode={toggleNode}
            onToggleBranch={() => {}}
            onSelect={handleSelect}
            onFork={node => { void handleFork(node) }}
            onForkUserPrompt={node => { void handleSelect(row.node.nodeId, node) }}
            t={t}
          />
        ))}
      </div>
    </section>
  )
}

export function SessionTreePanel(props: SessionTreeViewProps & PropsLocale<'session-tree'>) {
  const modeSnapshot = useSyncExternalStore(
    props.modeController?.subscribe ?? NOOP_SUBSCRIBE,
    props.modeController?.getSnapshot ?? NOOP_GET_MODE_SNAPSHOT,
    props.modeController?.getSnapshot ?? NOOP_GET_MODE_SNAPSHOT,
  )
  const selectorMode = props.mode === 'selectUserPrompt' || modeSnapshot.selectorOpen
  const { useSessions, openSession, jumpSession } = props
  if (!selectorMode && useSessions !== undefined && openSession !== undefined && jumpSession !== undefined) {
    return (
      <MergedSessionTreePanel
        {...props}
        useSessions={useSessions}
        openSession={openSession}
        jumpSession={jumpSession}
      />
    )
  }
  return <LegacySessionTreePanel {...props} selectorMode={selectorMode} />
}

export function SessionTreeDock(props: SessionTreeViewProps & PropsLocale<'session-tree'>) {
  return <SessionTreePanel {...props} />
}
