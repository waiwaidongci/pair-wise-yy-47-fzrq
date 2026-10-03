import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { BatchSubmitBody, Issue, RetestDraft, RuntimeState } from './types'
import {
  claim,
  createServerState,
  recomputeAll,
  releaseClaim,
  removeDraft,
  saveDraft,
  submitBatch,
  submitDevCandidate,
  type ServerState,
} from './engine'

let state: ServerState = createServerState(seedIssues)

export const worker = setupWorker(
  http.get('/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = state.issues.filter(
      (issue) =>
        (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) &&
        (!status || issue.status === status) &&
        (!site || issue.site === site),
    )
    return HttpResponse.json(filtered)
  }),

  http.post('/api/issues/:key/dev-submit', async ({ params, request }) => {
    const body = (await request.json()) as { version: string; fixNote?: string; retestEnv?: string; actor: string }
    const issue = submitDevCandidate(state, params.key as string, body)
    if (!issue) return new HttpResponse(null, { status: 404 })
    return HttpResponse.json(issue)
  }),

  http.post('/api/issues/:key/claim', async ({ params, request }) => {
    const body = (await request.json().catch(() => ({}))) as { actor?: string }
    if (!body.actor) return HttpResponse.json({ error: 'actor required' }, { status: 400 })
    const result = claim(state, params.key as string, body.actor)
    return HttpResponse.json(result)
  }),

  http.delete('/api/issues/:key/claim', ({ params }) => {
    releaseClaim(state, params.key as string)
    return HttpResponse.json({ ok: true })
  }),

  http.post('/api/retest/batch', async ({ request }) => {
    const body = (await request.json()) as BatchSubmitBody
    try {
      const outcome = submitBatch(state, body)
      if (outcome.ok) return HttpResponse.json(outcome.result)
      return HttpResponse.json(outcome.body, { status: outcome.status })
    } catch (error) {
      // 写入发生在任何数据变更之前；前端用同一 batchId 重试即可幂等
      if (error instanceof Error && error.message === 'SIMULATED_WRITE_FAULT') {
        return HttpResponse.json({ error: 'write-fault', batchId: body.batchId }, { status: 500 })
      }
      throw error
    }
  }),

  http.get('/api/drafts', () => HttpResponse.json(state.drafts)),

  http.post('/api/drafts', async ({ request }) => {
    const body = (await request.json()) as Omit<RetestDraft, 'id' | 'createdAt'>
    return HttpResponse.json(saveDraft(state, body))
  }),

  http.delete('/api/drafts/:id', ({ params }) => {
    removeDraft(state, params.id as string)
    return HttpResponse.json({ ok: true })
  }),

  http.get('/api/runtime', () => HttpResponse.json({ ...state.runtime, faultArmed: state.faultArmed } satisfies RuntimeState)),

  http.post('/api/runtime', async ({ request }) => {
    const body = (await request.json()) as Partial<RuntimeState>
    if (body.rollbackVersion !== undefined) state.runtime.rollbackVersion = body.rollbackVersion
    if (body.expiredKeys) state.runtime.expiredKeys = body.expiredKeys
    if (typeof body.faultArmed === 'boolean') state.faultArmed = body.faultArmed
    recomputeAll(state)
    return HttpResponse.json({ runtime: { ...state.runtime, faultArmed: state.faultArmed }, issues: state.issues })
  }),

  http.post('/api/runtime/reset', () => {
    state = createServerState(seedIssues)
    return HttpResponse.json(state.issues)
  }),

  http.post('/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    state.issues = state.issues.map((issue) =>
      body.keys.includes(issue.key)
        ? {
            ...issue,
            team: body.team,
            owner: body.owner,
            dueDate: body.dueDate,
            priority: body.priority as Issue['priority'],
            status: '修复中',
            history: [...issue.history, { at: '刚刚', actor: '当前用户', action: '批量分配', detail: `指派至 ${body.team} / ${body.owner}` }],
          }
        : issue,
    )
    return HttpResponse.json({ updated: body.keys.length })
  }),
)
