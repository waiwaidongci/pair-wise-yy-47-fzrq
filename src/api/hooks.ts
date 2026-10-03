import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import axios from 'axios'
import type { BatchConflictResponse, BatchSubmitBody, BatchSubmitResult, Issue, RetestDraft, RuntimeState } from './types'
import { useWorkspaceStore } from '../store/useWorkspaceStore'

const client = axios.create()

/** 服务端返回 409 时保留结构化冲突体 */
client.interceptors.response.use(
  (response) => response,
  (error) => {
    if (axios.isAxiosError(error) && error.response?.status === 409) {
      return Promise.reject(Object.assign(new Error('BATCH_CONFLICT'), { conflicts: error.response.data as BatchConflictResponse }))
    }
    return Promise.reject(error)
  },
)

export function useDrafts() {
  return useQuery({
    queryKey: ['drafts'],
    queryFn: async () => (await client.get<RetestDraft[]>('/api/drafts')).data,
  })
}

export function useRuntime() {
  return useQuery({
    queryKey: ['runtime'],
    queryFn: async () => (await client.get<RuntimeState>('/api/runtime')).data,
  })
}

export function useBatchSubmit() {
  const queryClient = useQueryClient()
  const setIssues = useWorkspaceStore((state) => state.setIssues)
  return useMutation({
    mutationFn: async (body: BatchSubmitBody) =>
      (await client.post<BatchSubmitResult>('/api/retest/batch', body)).data,
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['drafts'] })
      void queryClient.invalidateQueries({ queryKey: ['runtime'] })
      if (result.written.length) {
        // 写入后服务端已是当前记录：整量拉取一次，保证依据/链状态按最新口径渲染
        void client.get<Issue[]>('/api/issues').then(({ data }) => setIssues(data))
      }
    },
  })
}

export function useClaim() {
  return useMutation({
    mutationFn: async ({ key, actor }: { key: string; actor: string }) =>
      (await client.post<{ held: boolean; claim?: { actor: string; at: string } }>(`/api/issues/${key}/claim`, { actor })).data,
  })
}

export function useReleaseClaim() {
  return useMutation({ mutationFn: async (key: string) => (await client.delete(`/api/issues/${key}/claim`)).data })
}

export function useDiscardDraft() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => (await client.delete(`/api/drafts/${id}`)).data,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['drafts'] }),
  })
}

export function useRuntimeActions() {
  const queryClient = useQueryClient()
  const setIssues = useWorkspaceStore((state) => state.setIssues)
  return useMutation({
    mutationFn: async (patch: Partial<RuntimeState>) =>
      (await client.post<{ runtime: RuntimeState; issues: Issue[] }>('/api/runtime', patch)).data,
    onSuccess: (data) => {
      setIssues(data.issues)
      void queryClient.invalidateQueries({ queryKey: ['runtime'] })
      void queryClient.invalidateQueries({ queryKey: ['issues'] })
    },
  })
}

export function useResetDemo() {
  const setIssues = useWorkspaceStore((state) => state.setIssues)
  return useMutation({
    mutationFn: async () => (await client.post<Issue[]>('/api/runtime/reset')).data,
    onSuccess: (issues) => setIssues(issues),
  })
}

export function useDevSubmit() {
  const setIssues = useWorkspaceStore((state) => state.setIssues)
  return useMutation({
    mutationFn: async (input: { key: string; version: string; fixNote: string; retestEnv: string; actor: string }) =>
      (await client.post<Issue>(`/api/issues/${input.key}/dev-submit`, input)).data,
    onSuccess: (issue) => {
      setIssues(useWorkspaceStore.getState().issues.map((item) => (item.key === issue.key ? issue : item)))
    },
  })
}
