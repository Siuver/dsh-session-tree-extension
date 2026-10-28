/**
 * Branch overview above the merged graph: every lineage Session as one row of
 * an indented tree, with where it branched off and how many turns it added.
 * Choosing a row focuses the graph on that Session's history.
 */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionTreeKey } from './locales.ts'
import type { BranchTreeBadge, SessionGraphBranch } from './session-graph.ts'
import css from './SessionTreePanel.module.css'

/** Class for one branch color slot; slot 0 is the neutral trunk color. */
export function branchColorClass(color: number): string | undefined {
  return css[`branchColor${String(color)}`]
}

const KIND_LABELS: Record<BranchTreeBadge, SessionTreeKey> = {
  main: 'branch.tree.main',
  fork: 'branch.node.forkBadge',
  clone: 'branch.tree.cloneBadge',
}

const KIND_CLASSES: Record<BranchTreeBadge, string | undefined> = {
  main: css.mainBadge,
  fork: css.forkBadge,
  clone: css.cloneBadge,
}

/** Short statistics line: the turn a branch left its parent and the turns it added. */
function branchMeta(branch: SessionGraphBranch, t: (key: SessionTreeKey) => string): string {
  if (branch.placeholder === 'loading') return t('panel.graph.loading')
  if (branch.placeholder === 'error') return t('panel.graph.error')
  const turns = (key: SessionTreeKey, count: number): string => t(key).replace('{n}', String(count))
  if (branch.parentId === undefined) return turns('branch.overview.turns', branch.ownTurns)
  return `${turns('branch.overview.forkedAfter', branch.inheritedTurns)} · ${turns('branch.overview.newTurns', branch.ownTurns)}`
}

function OverviewRow({
  branch,
  focused,
  onFocus,
  onOpen,
  t,
}: {
  branch: SessionGraphBranch
  focused: boolean
  onFocus: (sessionId: SessionId | null) => void
  onOpen: (sessionId: SessionId) => void | Promise<void>
  t: (key: SessionTreeKey) => string
}) {
  const classes = [css.overviewRow, focused ? css.overviewRowFocused : undefined].filter(Boolean).join(' ')
  return (
    <li className={classes} data-branch-overview={branch.sessionId}>
      {/* The first entry is the trunk's level, which has no siblings to rail. */}
      {branch.railContinues.slice(1).map((continues, level) => (
        <span
          key={level}
          className={[css.overviewCell, continues ? css.overviewRail : undefined].filter(Boolean).join(' ')}
          aria-hidden="true"
        />
      ))}
      {branch.depth > 0 ? (
        <span
          className={[css.overviewCell, css.overviewElbow, branch.isLast ? css.overviewElbowLast : undefined]
            .filter(Boolean)
            .join(' ')}
          aria-hidden="true"
        />
      ) : null}
      <button
        type="button"
        className={css.overviewSelect}
        aria-pressed={focused}
        aria-label={`${t('branch.overview.focus')} — ${branch.title}`}
        title={t('branch.overview.focus')}
        onClick={() => { onFocus(focused ? null : branch.sessionId) }}
      >
        <span className={css.overviewTopline}>
          <span className={[css.swatch, branchColorClass(branch.color)].filter(Boolean).join(' ')} aria-hidden="true" />
          <span className={KIND_CLASSES[branch.kind]}>{t(KIND_LABELS[branch.kind])}</span>
          {branch.branchLabel === undefined ? null : <span className={css.branchChip}>{branch.branchLabel}</span>}
          <span className={css.overviewTitle}>{branch.title}</span>
          {branch.current ? <span className={css.currentChip}>{t('branch.tree.current')}</span> : null}
          {branch.running ? <span className={css.runningDot} /> : null}
        </span>
        <span className={css.overviewDetail}>
          <span className={css.overviewMeta}>{branchMeta(branch, t)}</span>
          {branch.parentId === undefined || branch.firstPrompt === undefined
            ? null
            : <span className={css.overviewPrompt}>“{branch.firstPrompt}”</span>}
        </span>
      </button>
      {branch.current ? <span className={css.overviewOpenPlaceholder} aria-hidden="true" /> : (
        <button
          type="button"
          className={css.overviewOpen}
          aria-label={`${t('branch.node.open')} — ${branch.title}`}
          title={t('branch.node.open')}
          onClick={() => { void onOpen(branch.sessionId) }}
        >
          ↗
        </button>
      )}
    </li>
  )
}

/**
 * Collapsible lineage tree. The first row clears the focus and shows every
 * branch merged into one graph.
 * @param focusSessionId - the Session the graph is limited to, if any.
 */
export function BranchOverview({
  branches,
  focusSessionId,
  expanded,
  onToggle,
  onFocus,
  onOpen,
  t,
}: {
  branches: readonly SessionGraphBranch[]
  focusSessionId: SessionId | undefined
  expanded: boolean
  onToggle: () => void
  onFocus: (sessionId: SessionId | null) => void
  onOpen: (sessionId: SessionId) => void | Promise<void>
  t: (key: SessionTreeKey) => string
}) {
  const toggleLabel = expanded ? t('branch.overview.collapse') : t('branch.overview.expand')
  return (
    <section className={css.overview} aria-label={t('branch.overview.title')}>
      <button
        type="button"
        className={css.overviewHeader}
        aria-expanded={expanded}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={onToggle}
      >
        <svg className={css.overviewChevron} viewBox="0 0 12 12" aria-hidden="true">
          <path d="M4 2l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className={css.overviewHeading}>{t('branch.overview.title')}</span>
        <span className={css.overviewCount}>{branches.length}</span>
      </button>
      {expanded ? (
        <ul className={css.overviewList}>
          <li className={[css.overviewRow, focusSessionId === undefined ? css.overviewRowFocused : undefined].filter(Boolean).join(' ')}>
            <button
              type="button"
              className={css.overviewSelect}
              aria-pressed={focusSessionId === undefined}
              title={t('branch.overview.allHint')}
              onClick={() => { onFocus(null) }}
            >
              <span className={css.overviewTopline}>
                <span className={css.overviewTitle}>{t('branch.overview.all')}</span>
                <span className={css.overviewHint}>{t('branch.overview.allHint')}</span>
              </span>
            </button>
          </li>
          {branches.map(branch => (
            <OverviewRow
              key={branch.sessionId}
              branch={branch}
              focused={branch.sessionId === focusSessionId}
              onFocus={onFocus}
              onOpen={onOpen}
              t={t}
            />
          ))}
        </ul>
      ) : null}
    </section>
  )
}
