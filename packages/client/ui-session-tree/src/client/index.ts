/** Browser half of the session-tree extension: a Conversation View beside Chat and Trajectory. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import sessionTreeRemote from '@robiteame/dsh-pi-agent-session-tree/remote'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CommandResult } from '@deepseek-ai/dsh-commands/types'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'command/executed'(sessionId: SessionId, name: string, result: CommandResult): void
  }
}
import type { SessionTreeForkView, SessionTreeView, TreeNode } from '@robiteame/dsh-pi-agent-session-tree/client'
import { SessionForkLineage, browserForkLineageStorage, summarizeForkPrompt } from './fork-lineage.ts'
import type { SessionTreePanelActions } from './slots.ts'
import { SessionTreeConversationView } from './SessionTreeConversationView.tsx'
import { SessionBranchList } from './SessionBranchList.tsx'
import type { SessionTreeRemoteActions } from './SessionTreeOverlay.tsx'
import { en, zh, type SessionTreeKey } from './locales.ts'
import './ChatResizeContainment.module.css'

export { SessionTreePanel, SessionTreeDock } from './SessionTreePanel.tsx'
export { SessionTreeOverlay, SessionTreeOverlayController } from './SessionTreeOverlay.tsx'
export type { SessionTreeOverlayProps, SessionTreeOverlayState } from './SessionTreeOverlay.tsx'
export { SessionBranchList } from './SessionBranchList.tsx'
export { buildBranchTreeModel, buildSessionGraphModel, visibleBranchRows } from './session-graph.ts'
export type {
  BranchTreeBadge,
  BranchTreeListState,
  BranchTreeModel,
  BranchTreeRow,
  SessionGraphBadge,
  SessionGraphModel,
  SessionGraphPlaceholder,
  SessionGraphRow,
} from './session-graph.ts'
export { SessionForkLineage, summarizeForkPrompt } from './fork-lineage.ts'
export type { SessionBranchListProps } from './SessionBranchList.tsx'
export type { ForkLineageEntry, ForkLineageRecordInput, ForkLineageStorage } from './fork-lineage.ts'
export type { SessionTreePanelActions, SessionTreeViewProps } from './slots.ts'
export type { SessionTreeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'session-tree': SessionTreeKey }
}

const NS = 'session-tree'
export const inject = ['slots', 'sessions', 'conversation', 'remote', 'locale']

/** Runtime-only editor face exposed by the native SessionInput shell. */
interface NativeSessionInput {
  readonly editor?: {
    parseEditorState(value: unknown): unknown
    setEditorState(state: unknown): void
  }
}

interface WorkspaceArchiveController {
  readonly list?: {
    getSnapshot(): { readonly archivedSessionIds?: readonly SessionId[] }
  }
  unarchiveSession?(sessionId: SessionId): Promise<void>
}

interface UiWorkspaceNavigation {
  openSession(sessionId: SessionId): void
  unarchiveSession?(sessionId: SessionId): Promise<void>
}

interface RuntimeChatNode {
  readonly key: string
  readonly kind: string
  readonly anchorSeq: number
  readonly visibility?: string
  readonly location?: {
    readonly turn?: { readonly turn?: number }
  }
  readonly data?: {
    readonly seq?: number
    readonly finalNode?: { readonly seq?: number }
    readonly root?: { readonly seq?: number; readonly callId?: string }
  }
}

interface RuntimeSessionBinding {
  readonly session?: {
    getSnapshot?(): {
      readonly openState?: string
      readonly loadingOlder?: boolean
    }
    subscribe?(listener: () => void): () => void
    loadThrough?(seq: number): Promise<void>
  }
}

interface RuntimeUiConversation {
  binding?(source: unknown): {
    activate?(target: string): void
    target?(name: 'chat'): {
      getSnapshot?(): {
        readonly nodes?: {
          values?(): readonly RuntimeChatNode[]
        }
      } | undefined
    }
  }
}

const CONVERSATION_STORE_PREFIX = 'dsh.conversation.'

function preferChatView(sessionId: SessionId): void {
  try {
    if (typeof localStorage !== 'object' || localStorage === null) return
    const key = `${CONVERSATION_STORE_PREFIX}${sessionId}`
    const raw = localStorage.getItem(key)
    const parsed: unknown = raw === null ? {} : JSON.parse(raw)
    const base = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { draft: '', viewRequest: null }
    localStorage.setItem(key, JSON.stringify({ draft: '', viewRequest: null, ...base, view: 'chat' }))
  } catch {
    // Ignore storage errors in restricted environments.
  }
}

function parseEventSeq(nodeId: string): number | undefined {
  const match = /^session-event-(\d+)$/u.exec(nodeId)
  if (match === null) return undefined
  const value = Number(match[1])
  return Number.isSafeInteger(value) ? value : undefined
}

function nodeSeqs(node: TreeNode): {
  readonly primarySeq: number | undefined
  readonly resultSeq: number | undefined
  readonly callId: string | undefined
} {
  const metaPrimary = node.metadata?.sessionEventSeq
  const metaSource = node.metadata?.sourceEventSeq
  const primarySeq = typeof metaPrimary === 'number' && Number.isSafeInteger(metaPrimary)
    ? metaPrimary
    : typeof metaSource === 'number' && Number.isSafeInteger(metaSource)
      ? metaSource
      : parseEventSeq(node.nodeId)
  const metaResult = node.metadata?.toolResultEventSeq
  const resultSeq = typeof metaResult === 'number' && Number.isSafeInteger(metaResult)
    ? metaResult
    : undefined
  const callPart = node.content?.find(part => part.type === 'tool_call')
  const callId = node.message?.toolCallId ?? (callPart?.type === 'tool_call' ? callPart.id : undefined)
  return { primarySeq, resultSeq, callId }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => { resolve() })
    } else {
      setTimeout(resolve, 0)
    }
  })
}

async function waitForSessionReady(binding: RuntimeSessionBinding | undefined): Promise<void> {
  const session = binding?.session
  if (session?.getSnapshot === undefined || session.subscribe === undefined) return
  const ready = (): boolean => {
    const snap = session.getSnapshot?.()
    return snap?.openState !== 'loading' && snap?.loadingOlder !== true
  }
  if (ready()) return
  await new Promise<void>(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      unsubscribe()
      resolve()
    }
    const timer = setTimeout(finish, 3000)
    const unsubscribe = session.subscribe!(() => {
      if (ready()) finish()
    })
    if (ready()) finish()
  })
}

function findMatchingChatNode(
  nodes: readonly RuntimeChatNode[],
  primarySeq: number | undefined,
  resultSeq: number | undefined,
  callId: string | undefined,
): RuntimeChatNode | undefined {
  const visible = nodes.filter(
    candidate => candidate.visibility !== 'hidden'
      && candidate.kind !== 'turn-process'
      && candidate.kind !== 'turn-tail',
  )
  const exact = visible.find(candidate =>
    (primarySeq !== undefined && (
      candidate.anchorSeq === primarySeq
      || candidate.data?.seq === primarySeq
      || candidate.data?.finalNode?.seq === primarySeq
      || candidate.data?.root?.seq === primarySeq
    ))
    || (resultSeq !== undefined && (
      candidate.anchorSeq === resultSeq
      || candidate.data?.seq === resultSeq
      || candidate.data?.root?.seq === resultSeq
    ))
    || (callId !== undefined && candidate.data?.root?.callId === callId),
  )
  if (exact !== undefined || primarySeq === undefined) return exact
  let nearest: RuntimeChatNode | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of visible) {
    const distance = Math.abs(candidate.anchorSeq - primarySeq)
    if (distance < bestDistance) {
      bestDistance = distance
      nearest = candidate
    }
  }
  return nearest
}

function findChatRowInDom(
  scroller: HTMLElement,
  targetKey: string | undefined,
  targetTurn: number | undefined,
  node: TreeNode,
): HTMLElement | null {
  if (targetKey !== undefined) {
    const matches = [...scroller.querySelectorAll<HTMLElement>('[data-chat-node-key]')]
      .filter(element => element.dataset.chatNodeKey === targetKey)
    if (matches.length > 0) {
      if (node.type === 'message') {
        return matches.find(element => element.dataset.chatGroupPart === 'response')
          ?? matches.find(element => element.dataset.chatGroupPart !== 'reasoning')
          ?? matches[0]
          ?? null
      }
      return matches[0] ?? null
    }
  }
  if (targetTurn !== undefined) {
    return scroller.querySelector<HTMLElement>(`[data-chat-turn="${String(targetTurn)}"]`)
  }
  return null
}

/**
 * Open a Session through 0.2 Workspace navigation, or the legacy sessions face.
 * An archived Session is unarchived first so `UiWorkspaceService.clearArchivedCurrent`
 * does not clear the main selection immediately after opening it.
 */
function revealSession(ctx: ClientContext, sessionId: SessionId): void | Promise<void> {
  preferChatView(sessionId)
  const workspace = ctx.get('uiWorkspace') as UiWorkspaceNavigation | undefined
  const workspaces = (ctx as unknown as { get(key: string): unknown }).get('workspaces') as WorkspaceArchiveController | undefined
  const openNow = (): void => {
    if (workspace !== undefined) {
      workspace.openSession(sessionId)
      return
    }
    ;(ctx.sessions as unknown as { open(id: SessionId): void }).open(sessionId)
  }
  const archived = workspaces?.list?.getSnapshot().archivedSessionIds?.includes(sessionId) === true
  if (archived) {
    const unarchive = workspace?.unarchiveSession?.bind(workspace) ?? workspaces?.unarchiveSession?.bind(workspaces)
    if (unarchive !== undefined) {
      return unarchive(sessionId).then(() => { openNow() })
    }
  }
  openNow()
}

/**
 * Switch the target Session to the Chat view, page its event window through the
 * clicked node's sequence if needed, and scroll the Chat viewport to that node.
 */
async function revealNodeInChat(ctx: ClientContext, sessionId: SessionId, node: TreeNode): Promise<void> {
  preferChatView(sessionId)
  const binding = ctx.sessions.binding(sessionId) as RuntimeSessionBinding | undefined
  const uiConversation = (ctx as unknown as { get(key: string): unknown }).get('uiConversation') as RuntimeUiConversation | undefined
  const convBinding = binding === undefined ? undefined : uiConversation?.binding?.(binding)
  convBinding?.activate?.('chat')

  const { primarySeq, resultSeq, callId } = nodeSeqs(node)
  if (binding?.session !== undefined) {
    await waitForSessionReady(binding)
    if (primarySeq !== undefined && typeof binding.session.loadThrough === 'function') {
      await binding.session.loadThrough(primarySeq)
    }
  }

  if (typeof document === 'undefined') return
  const firstTab = document.querySelector<HTMLElement>('[data-conversation-tabs] [role="tab"]')
  if (firstTab !== null && firstTab.getAttribute('aria-selected') === 'false') {
    firstTab.click()
  }

  const resolveTarget = (): { readonly key: string | undefined; readonly turn: number | undefined } => {
    const activeBinding = (ctx.sessions.binding(sessionId) as RuntimeSessionBinding | undefined) ?? binding
    const activeConv = activeBinding === undefined ? convBinding : uiConversation?.binding?.(activeBinding)
    const nodes = activeConv?.target?.('chat')?.getSnapshot?.()?.nodes?.values?.() ?? []
    const matched = findMatchingChatNode(nodes, primarySeq, resultSeq, callId)
    return {
      key: matched?.key,
      turn: matched?.location?.turn?.turn,
    }
  }

  let scroller: HTMLElement | null = null
  let targetRow: HTMLElement | null = null
  let resolved = resolveTarget()
  for (let attempt = 0; attempt < 20; attempt++) {
    resolved = resolveTarget()
    scroller = document.querySelector<HTMLElement>('[data-conversation-scroll]')
    if (scroller !== null && (resolved.key !== undefined || resolved.turn !== undefined)) {
      targetRow = findChatRowInDom(scroller, resolved.key, resolved.turn, node)
      if (targetRow !== null) break
    }
    if (binding === undefined && scroller === null) return
    await nextAnimationFrame()
  }
  if (scroller === null || targetRow === null) return

  const hiddenChain: HTMLElement[] = []
  for (
    let current: HTMLElement | null = targetRow;
    current !== null && current !== scroller;
    current = current.parentElement
  ) {
    if (current.hasAttribute('hidden')) hiddenChain.unshift(current)
  }
  if (hiddenChain.length > 0) {
    for (const hiddenElement of hiddenChain) {
      hiddenElement.dispatchEvent(new Event('beforematch'))
    }
    await nextAnimationFrame()
    targetRow = findChatRowInDom(scroller, resolved.key, resolved.turn, node) ?? targetRow
  }

  const alignScroller = (activeScroller: HTMLElement): void => {
    const currentRow = findChatRowInDom(activeScroller, resolved.key, resolved.turn, node) ?? targetRow
    if (currentRow === null) return
    const groupBody = currentRow.closest<HTMLElement>('[data-step-process-body]')
    if (groupBody !== null && groupBody.scrollHeight > groupBody.clientHeight) {
      const bodyRect = groupBody.getBoundingClientRect()
      const itemRect = currentRow.getBoundingClientRect()
      groupBody.scrollTop = Math.max(0, groupBody.scrollTop + (itemRect.top - bodyRect.top) - 12)
      groupBody.dispatchEvent(new Event('scroll'))
      groupBody.dispatchEvent(new Event('scrollend'))
    }
    const scrollerRect = activeScroller.getBoundingClientRect()
    const rowRect = currentRow.getBoundingClientRect()
    const maxTop = Math.max(0, activeScroller.scrollHeight - activeScroller.clientHeight)
    const desiredTop = Math.max(0, Math.min(maxTop, activeScroller.scrollTop + (rowRect.top - scrollerRect.top) - 24))
    const followingTail = activeScroller.querySelector('[data-chat-following-tail]') !== null
      || activeScroller.closest('[data-chat-following-tail]') !== null
    activeScroller.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    if (desiredTop < maxTop - 1 && Math.abs(activeScroller.scrollTop - desiredTop) <= 0.5 && followingTail) {
      activeScroller.scrollTop = Math.min(maxTop, desiredTop + 2)
      activeScroller.dispatchEvent(new Event('scroll'))
      activeScroller.dispatchEvent(new Event('scrollend'))
    }
    if (Math.abs(activeScroller.scrollTop - desiredTop) > 0.5 || followingTail) {
      activeScroller.scrollTop = desiredTop
      activeScroller.dispatchEvent(new Event('scroll'))
      activeScroller.dispatchEvent(new Event('scrollend'))
    }
  }

  alignScroller(scroller)
  await nextAnimationFrame()
  alignScroller(scroller)
}

/** Build the serialized Lexical state used to seed one native composer. */
function editorStateForText(text: string): unknown {
  return {
    root: {
      children: text.split('\n').map(line => ({
        children: line === ''
          ? []
          : [{
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text: line,
              type: 'text',
              version: 1,
            }],
        direction: null,
        format: '',
        indent: 0,
        textFormat: 0,
        textStyle: '',
        type: 'paragraph',
        version: 1,
      })),
      direction: null,
      format: '',
      indent: 0,
      textFormat: 0,
      textStyle: '',
      type: 'root',
      version: 1,
    },
  }
}

/** Register UI only after the generated Remote namespace has been mounted. */
async function registerSessionTreeUi(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-session-tree: dictionaries')
  const refreshers = new Map<SessionId, Set<() => void>>()
  ctx.effect(() => () => { refreshers.clear() }, 'ui-session-tree: refreshers')
  // Fork presentation annotations for the inline session-list menus. The
  // fork data and parent linkage stay owned by ctx.sessions.fork; only the
  // fork-vs-clone distinction and the branch title live here.
  const forkLineage = new SessionForkLineage(browserForkLineageStorage())
  ctx.effect(() => () => { forkLineage.dispose() }, 'ui-session-tree: fork lineage')

  /** Write a fork prompt through the child Session's native editor instance. */
  const writeNativePrompt = (sessionId: SessionId, text: string): void => {
    const binding = ctx.sessions.binding(sessionId)
    if (binding === undefined) throw new Error('fork child is not addressable')
    const input = ctx.conversation.input.for(binding.ctx) as unknown as NativeSessionInput
    const editor = input.editor
    if (editor === undefined) throw new Error('fork child native input editor is unavailable')
    editor.setEditorState(editor.parseEditorState(editorStateForText(text)))
  }

  /** Seed the new fork's native composer before revealing it. */
  const completeFork = (result: SessionTreeForkView): void => {
    if (result.sessionId === undefined) return
    if (result.prompt !== undefined) writeNativePrompt(result.sessionId, result.prompt)
    revealSession(ctx, result.sessionId)
  }

  /** Fork through the same native session service used by the sidebar menu. */
  const forkNative = async (sessionId: SessionId, atSeq?: number): Promise<SessionId> => {
    return ctx.sessions.fork({
      sessionId,
      ...(atSeq === undefined ? {} : { atSeq }),
      increaseTitle: true,
    })
  }

  /** Fork and reveal a child without an editable prompt. */
  const openNativeFork = async (sessionId: SessionId, atSeq?: number): Promise<SessionId> => {
    const childId = await forkNative(sessionId, atSeq)
    await revealSession(ctx, childId)
    return childId
  }

  const remoteActions: SessionTreeRemoteActions = {
    load: async (sessionId) => {
      const answered = await ctx.remote.sessionTree.list(sessionId)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    jump: async (sessionId, nodeId) => {
      const answered = await ctx.remote.sessionTree.jump(sessionId, nodeId)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      return answered.value
    },
    fork: async (sessionId, nodeId, branch) => {
      const answered = await ctx.remote.sessionTree.forkSession(sessionId, nodeId, branch)
      if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`)
      if (answered.value.sessionId !== undefined) {
        forkLineage.record({
          childId: answered.value.sessionId,
          parentId: sessionId,
          ...(answered.value.previousUserPrompt === undefined
            ? {}
            : { summary: summarizeForkPrompt(answered.value.previousUserPrompt) }),
          branch,
        })
      }
      return answered.value
    },
    onRefresh: (sessionId, callback) => {
      const set = refreshers.get(sessionId) ?? new Set<() => void>()
      set.add(callback); refreshers.set(sessionId, set)
      return () => { set.delete(callback); if (set.size === 0) refreshers.delete(sessionId) }
    },
  }

  /** Compose the action face handed to the Conversation View. */
  const panelActions = (sessionId: SessionId): SessionTreePanelActions => ({
    load: remoteActions.load,
    jump: nodeId => remoteActions.jump(sessionId, nodeId),
    jumpSession: remoteActions.jump,
    fork: async (nodeId, branch) => {
      const result = await remoteActions.fork(sessionId, nodeId, branch)
      completeFork(result)
      return result
    },
    onRefresh: callback => remoteActions.onRefresh(sessionId, callback),
    lineage: forkLineage,
    openSession: (id: SessionId) => revealSession(ctx, id),
    revealNodeInChat: (id: SessionId, node: TreeNode) => revealNodeInChat(ctx, id, node),
  })

  // One Conversation View tab after Chat and Trajectory (order 10).
  const translate = typeof ctx.locale.bind === 'function'
    ? ctx.locale.bind(NS)
    : (key: SessionTreeKey) => zh[key]
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'session-tree',
    order: 20,
    locale: NS,
    label: () => translate('panel.title'),
    inject: panelActions,
  }, SessionTreeConversationView))

  // Inline fork menus under native Session rows. They render nothing until a
  // fork records a live branch, so ordinary sessions and /clone children keep
  // their native presentation.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'session-tree-branches', order: 11, locale: NS,
    inject: () => ({
      lineage: forkLineage,
      openSession: (sessionId: SessionId) => revealSession(ctx, sessionId),
    }),
  }, SessionBranchList))

  ctx.on('command/executed', (sessionId: SessionId, name: string, result: CommandResult) => {
    if (name !== 'clone') return
    if (result.kind === 'success' && result.text !== undefined) {
      try {
        const payload = JSON.parse(result.text) as { value?: { nativeForkRequired?: boolean } }
        if (payload.value?.nativeForkRequired === true) {
          void openNativeFork(sessionId).catch(() => {
            // A failed fork leaves the source open.
          })
        }
      } catch {
        // A non-JSON success is still a valid Host outcome; it simply has no navigable fork id.
      }
    }
    for (const refresh of refreshers.get(sessionId) ?? []) refresh()
  })
}

export async function apply(ctx: ClientContext): Promise<() => Promise<void>> {
  const unmountRemote = await ctx.remote.$mount(sessionTreeRemote)
  // `remote.sessionTree` is created by $mount above. Cordis nested services must
  // be declared explicitly, so consume it from a child injection scope rather
  // than reading it from the outer scope that only injects `remote`.
  const ui = ctx.inject(
    ['slots', 'sessions', 'conversation', 'remote.sessionTree', 'locale'],
    registerSessionTreeUi,
  )
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await unmountRemote()
    throw error
  }
  return async () => {
    await ui.dispose()
    await unmountRemote()
  }
}

export type LoadedSessionTreeView = SessionTreeView
