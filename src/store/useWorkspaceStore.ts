import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Issue, RetestDraft } from '../api/types'
import { ensureChain } from '../api/conclusionChain'
import { seedIssues } from '../api/seed'

type SavedFilter = { id: string; name: string; query: string; site: string; status: string; priority: string }

const now = () => new Date().toISOString()
const migrateList = (list: Issue[]): Issue[] => list.map((item) => ensureChain(item, now()))

type WorkspaceState = {
  issues: Issue[]
  selectedKeys: string[]
  savedFilters: SavedFilter[]
  draft: string
  mergeKeys: string[]
  drafts: RetestDraft[]
  setIssues: (issues: Issue[]) => void
  setSelectedKeys: (keys: string[]) => void
  saveFilter: (filter: Omit<SavedFilter, 'id'>) => void
  removeFilter: (id: string) => void
  setDraft: (draft: string) => void
  mergeIssues: (keys: string[]) => void
  updateIssue: (issue: Issue) => void
  addDraft: (draft: Omit<RetestDraft, 'id' | 'createdAt'>) => void
  removeDraft: (id: string) => void
  updateDraft: (id: string, patch: Partial<RetestDraft>) => void
  migrateAll: () => void
}

export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      issues: migrateList(structuredClone(seedIssues)),
      selectedKeys: [],
      savedFilters: [
        { id: 'f1', name: 'P0/P1 未关闭', query: '', site: '', status: '', priority: 'P0' },
        { id: 'f2', name: '基础组件组待复测', query: '基础组件', site: '', status: '待复测', priority: '' },
      ],
      draft: 'A11Y-1048：需同时验证 Esc 关闭与 Tab/Shift+Tab 环绕顺序，移动端抽屉也需复测。',
      mergeKeys: [],
      drafts: [],
      setIssues: (issues) => set({ issues: migrateList(issues) }),
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
      updateIssue: (updated) => set((state) => ({ issues: state.issues.map((issue) => (issue.key === updated.key ? ensureChain(updated, now()) : issue)) })),
      addDraft: (draft) =>
        set((state) => ({
          drafts: [
            ...state.drafts,
            { ...draft, id: `DRAFT-${crypto.randomUUID()}`, createdAt: '刚刚' },
          ],
        })),
      removeDraft: (id) => set((state) => ({ drafts: state.drafts.filter((item) => item.id !== id) })),
      updateDraft: (id, patch) => set((state) => ({ drafts: state.drafts.map((item) => (item.id === id ? { ...item, ...patch } : item)) })),
      migrateAll: () => set((state) => ({ issues: migrateList(state.issues) })),
    }),
    {
      name: 'accessibility-remediation-v1',
      version: 2,
      merge: (persisted, current) => {
        const persistedIssues = (persisted as Partial<WorkspaceState> | null)?.issues
        const issues = Array.isArray(persistedIssues) ? migrateList(persistedIssues) : current.issues
        const drafts = Array.isArray((persisted as Partial<WorkspaceState> | null)?.drafts) ? (persisted as Partial<WorkspaceState>).drafts! : current.drafts
        return { ...current, ...(persisted as object), issues, drafts }
      },
    },
  ),
)
