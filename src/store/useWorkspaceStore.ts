import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Issue } from '../api/types'
import { seedIssues, bootstrapChain } from '../api/seed'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

type WorkspaceState = {
  issues: Issue[]
  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]
  setIssues: (issues: Issue[]) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  mergeIssues: (keys: string[]) => void
  updateIssue: (issue: Issue) => void
}

/** 旧数据升级：本地持久化里没有结论链的问题补齐首版 */
function upgradeStoredIssue(issue: Issue): Issue {
  if (issue.chain && issue.chain.length > 0 && typeof issue.revision === 'number') return issue
  const { chain, records, revision } = bootstrapChain(issue)
  return { ...issue, chain, retestRecords: records, revision: issue.revision ?? revision }
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      issues: structuredClone(seedIssues).map(upgradeStoredIssue),
      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: 'A11Y-1048：需同时验证 Esc 关闭与 Tab/Shift+Tab 环绕顺序，移动端抽屉也需复测。',
      mergeKeys: [],
      setIssues: (issues) => set({ issues: issues.map(upgradeStoredIssue) }),
      setSelectedKeys: (selectedKeys) => set({ selectedKeys }),
      saveFilter: (filter) => set((state) => ({ savedFilters: [...state.savedFilters, { ...filter, id: crypto.randomUUID() }] })),
      removeFilter: (id) => set((state) => ({ savedFilters: state.savedFilters.filter((item) => item.id !== id) })),
      setDraft: (draft) => set({ draft }),
      mergeIssues: (keys) =>
        set((state) => {
          const primary = state.issues.find((issue) => issue.key === keys[0])
          if (!primary) return state
          return {
            issues: state.issues.map((issue) =>
              keys.includes(issue.key)
                ? {
                    ...issue,
                    rootCause: primary.rootCause,
                    status: issue.key === primary.key ? issue.status : '不适用',
                    mergedKeys: issue.key === primary.key ? keys.slice(1) : [primary.key],
                    history: [...issue.history, { at: '刚刚', actor: '当前用户', action: '重复问题合并', detail: `合并至 ${primary.key}` }],
                  }
                : issue,
            ),
            selectedKeys: [],
          }
        }),
      updateIssue: (updated) =>
        set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? upgradeStoredIssue(updated) : issue)) })),
    }),
    {
      name: 'accessibility-remediation-v1',
      version: 2,
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<WorkspaceState>
        if (version < 2 && Array.isArray(state.issues)) {
          state.issues = state.issues.map(upgradeStoredIssue)
        }
        return state
      },
    },
  ),
)
