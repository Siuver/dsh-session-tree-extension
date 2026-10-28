/** Conversation View beside Chat and Trajectory showing the open Session's lineage tree. */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreePanelActions } from './slots.ts'
import { SessionTreePanel } from './SessionTreePanel.tsx'
import css from './SessionTreePanel.module.css'

export type SessionTreeConversationViewProps =
  PropsRuntime<'conversation.view'>
  & PropsLocale<'session-tree'>
  & InjectFace<SessionTreePanelActions>

/**
 * Render the merged lineage graph for the View's Session.
 * @param props - framework View identity plus the session-tree action face.
 * @returns the tree surface filling the Conversation View area.
 */
export function SessionTreeConversationView({
  sessionId,
  useSessions,
  t,
  load,
  jump,
  jumpSession,
  select,
  fork,
  onRefresh,
  lineage,
  openSession,
  revealNodeInChat,
  openView,
}: SessionTreeConversationViewProps) {
  return (
    <div className={css.conversationView}>
      <SessionTreePanel
        panel="session-tree"
        sessionId={sessionId as SessionId}
        useSessions={useSessions}
        t={t}
        load={load}
        jump={jump}
        {...(jumpSession === undefined ? {} : { jumpSession })}
        {...(select === undefined ? {} : { select })}
        fork={fork}
        {...(onRefresh === undefined ? {} : { onRefresh })}
        {...(lineage === undefined ? {} : { lineage })}
        {...(openSession === undefined ? {} : { openSession })}
        {...(revealNodeInChat === undefined ? {} : { revealNodeInChat })}
        {...(openView === undefined ? {} : { openView })}
      />
    </div>
  )
}
