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
import type { SessionTreeForkView, SessionTreeView } from '@robiteame/dsh-pi-agent-session-tree/client'
import { SessionForkLineage, browserForkLineageStorage, summarizeForkPrompt } from './fork-lineage.ts'
import type { SessionTreePanelActions } from './slots.ts'
import { SessionTreeConversationView } from './SessionTreeConversationView.tsx'
import { SessionBranchList } from './SessionBranchList.tsx'
import type { SessionTreeRemoteActions } from './SessionTreeOverlay.tsx'
import { en, zh, type SessionTreeKey } from './locales.ts'

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

/**
 * Open a Session through 0.2 Workspace navigation, or the legacy sessions face.
 * `uiWorkspace` is optional and provided by another plugin, so it is read with
 * `ctx.get()`: property access on an uninjected service throws in Cordis 4.
 */
function revealSession(ctx: ClientContext, sessionId: SessionId): void {
  const workspace = ctx.get('uiWorkspace')
  if (workspace !== undefined) {
    workspace.openSession(sessionId)
    return
  }
  ;(ctx.sessions as unknown as { open(id: SessionId): void }).open(sessionId)
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
    revealSession(ctx, childId)
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
    openSession: (id: SessionId) => { revealSession(ctx, id) },
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
      openSession: (sessionId: SessionId) => { revealSession(ctx, sessionId) },
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
