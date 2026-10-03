import { setupWorker } from 'msw/browser'
import { http, HttpResponse } from 'msw'
import { seedIssues } from './seed'
import type { BatchReviewItem, Issue, RetestResult, VersionSnapshot } from './types'
import {
  applyRetest,
  ensureChain,
  evidenceHashOf,
  recompute,
  snapshotForVersion,
  snapshotHashOf,
  validateBatch,
} from './conclusionChain'

let issues: Issue[] = structuredClone(seedIssues)

const now = () => new Date().toISOString()

// 版本差异快照（基线 v4.18）
let snapshots: VersionSnapshot[] = [
  {
    id: 'SNAP-A11Y-1048',
    issueKey: 'A11Y-1048',
    version: 'v4.18',
    baseline: '待复测',
    candidate: '已提交复测材料',
    field: '修复状态',
    risk: '低',
    hash: snapshotHashOf({ version: 'v4.18', baseline: '待复测', candidate: '已提交复测材料', field: '修复状态', risk: '低' }),
    acceptedAt: '09-28 16:20',
  },
  {
    id: 'SNAP-A11Y-1074',
    issueKey: 'A11Y-1074',
    version: 'v4.18-rc2',
    baseline: '#98B7AF / 对比度 2.6:1',
    candidate: '#1D6570 / 对比度 5.1:1 + 纹理',
    field: '图表色板',
    risk: '低',
    hash: snapshotHashOf({ version: 'v4.18-rc2', baseline: '#98B7AF / 对比度 2.6:1', candidate: '#1D6570 / 对比度 5.1:1 + 纹理', field: '图表色板', risk: '低' }),
    acceptedAt: '09-28 16:20',
  },
  {
    id: 'SNAP-A11Y-1083',
    issueKey: 'A11Y-1083',
    version: 'v4.19-dev',
    baseline: '视觉错误颜色',
    candidate: 'aria-live + aria-describedby',
    field: '错误提示实现',
    risk: '中',
    hash: snapshotHashOf({ version: 'v4.19-dev', baseline: '视觉错误颜色', candidate: 'aria-live + aria-describedby', field: '错误提示实现', risk: '中' }),
    acceptedAt: '09-28 16:20',
  },
]

// 幂等：已处理的批次与单条请求，重试不重复追加记录
const processedBatches = new Map<string, { updated: number; keys: string[] }>()
const processedIdempotency = new Map<string, Issue>()
// 模拟写入失败（仅首次），用于验证「按原批次重试、不重复追加」
const failedOnce = new Set<string>()

const migrate = (list: Issue[]): Issue[] => list.map((item) => ensureChain(item, now()))

const normalizeResult = (value: string): RetestResult => {
  if (value === '已通过' || value === '通过') return '通过'
  if (value === '已退回' || value === '退回') return '退回'
  return '不适用'
}

export const worker = setupWorker(
  http.get('/api/issues', ({ request }) => {
    const url = new URL(request.url)
    const query = url.searchParams.get('query')?.toLowerCase() ?? ''
    const status = url.searchParams.get('status') ?? ''
    const site = url.searchParams.get('site') ?? ''
    const filtered = migrate(issues).filter(
      (issue) =>
        (!query || `${issue.key}${issue.title}${issue.rootCause}`.toLowerCase().includes(query)) &&
        (!status || issue.status === status) &&
        (!site || issue.site === site),
    )
    return HttpResponse.json(filtered)
  }),

  http.get('/api/versions', () => HttpResponse.json(snapshots)),

  http.post('/api/versions/accept', async ({ request }) => {
    const body = (await request.json()) as Omit<VersionSnapshot, 'id' | 'hash' | 'acceptedAt'>
    const snap: VersionSnapshot = {
      ...body,
      id: `SNAP-${body.issueKey}-${body.version}`,
      hash: snapshotHashOf(body),
      acceptedAt: now(),
    }
    snapshots = [...snapshots.filter((s) => !(s.issueKey === body.issueKey && s.version === body.version)), snap]
    return HttpResponse.json(snap)
  }),

  http.post('/api/versions/rollback', async ({ request }) => {
    const body = (await request.json()) as { snapshotId: string }
    const target = snapshots.find((s) => s.id === body.snapshotId)
    if (!target) return new HttpResponse(null, { status: 404 })
    snapshots = snapshots.map((s) => (s.id === body.snapshotId ? { ...s, rolledBackAt: now() } : s))
    const affected: string[] = []
    issues = issues.map((issue) => {
      const { issue: next, changed } = recompute(issue, snapshots, now())
      if (changed) affected.push(issue.key)
      return next
    })
    return HttpResponse.json({ snapshotId: body.snapshotId, affected })
  }),

  // 模拟另一位处理者抢先提交（乐观锁并发演示）
  // 模拟证据链接变更：证据哈希过期，相关结论立即失效并按当前记录重算
  http.post('/api/issues/:key/expire-evidence', async ({ params }) => {
    const found = issues.find((item) => item.key === params.key)
    if (!found) return new HttpResponse(null, { status: 404 })
    const bumped = { ...found, evidence: `${found.evidence}${found.evidence.includes('?') ? '&' : '?'}t=${Date.now()}`, updatedAt: now() }
    const { issue: next } = recompute(bumped, snapshots, now())
    issues = issues.map((item) => (item.key === params.key ? next : item))
    return HttpResponse.json(next)
  }),

  http.post('/api/issues/:key/simulate-concurrent', async ({ params }) => {
    const issue = issues.find((item) => item.key === params.key)
    if (!issue) return new HttpResponse(null, { status: 404 })
    issues = issues.map((item) =>
      item.key === params.key
        ? {
            ...item,
            versionSeq: (item.versionSeq ?? 1) + 1,
            updatedAt: now(),
            history: [...item.history, { at: '刚刚', actor: '另一位复测员', action: '并发处理', detail: '该问题已被抢先提交，后到者需保留草稿。' }],
          }
        : item,
    )
    return HttpResponse.json(issues.find((item) => item.key === params.key))
  }),

  http.post('/api/issues/review-batch', async ({ request }) => {
    const body = (await request.json()) as {
      batchId: string
      items: Array<BatchReviewItem & { result: string }>
      simulateFail?: boolean
    }
    // 幂等：同批次重试直接返回原结果，不重复追加记录
    const stored = processedBatches.get(body.batchId)
    if (stored) return HttpResponse.json({ batchId: body.batchId, ...stored, idempotent: true })

    if (body.simulateFail && !failedOnce.has(body.batchId)) {
      failedOnce.add(body.batchId)
      return HttpResponse.json({ error: '写入失败（模拟）', batchId: body.batchId }, { status: 500 })
    }

    const conflicts = validateBatch(issues, body.items, snapshots)
    if (conflicts.length) {
      return HttpResponse.json({ conflicts }, { status: 409 })
    }

    const applied: Issue[] = []
    for (const raw of body.items) {
      const item: BatchReviewItem = { ...raw, result: normalizeResult(raw.result) }
      const issue = issues.find((i) => i.key === item.issueKey)!
      const snap = snapshotForVersion(snapshots, item.basedOnVersion, item.issueKey, now())
      if (!snapshots.some((s) => s.id === snap.id)) snapshots = [...snapshots, snap]
      const record = {
        id: `RT-${Date.now()}-${item.issueKey}`,
        actor: '当前用户',
        result: item.result,
        note: item.note,
        at: '刚刚',
        environment: item.environment,
        basedOnVersion: item.basedOnVersion,
        evidenceHash: item.evidenceHash || evidenceHashOf(issue),
        conclusionId: '',
        batchId: body.batchId,
        idempotencyKey: body.batchId,
      }
      const next = applyRetest(issue, record, snap.id, now())
      issues = issues.map((i) => (i.key === item.issueKey ? next : i))
      applied.push(next)
    }
    const result = { updated: body.items.length, keys: body.items.map((i) => i.issueKey) }
    processedBatches.set(body.batchId, result)
    return HttpResponse.json({ batchId: body.batchId, ...result })
  }),

  http.post('/api/issues/:key/review', async ({ params, request }) => {
    const issue = issues.find((item) => item.key === params.key)
    if (!issue) return new HttpResponse(null, { status: 404 })
    const body = (await request.json()) as {
      result: string
      note: string
      environment: string
      basedOnSeq?: number
      evidenceHash?: string
      basedOnVersion?: string
      idempotencyKey?: string
      simulateFail?: boolean
    }

    if (body.idempotencyKey && processedIdempotency.has(body.idempotencyKey)) {
      return HttpResponse.json(processedIdempotency.get(body.idempotencyKey))
    }
    if (body.simulateFail && body.idempotencyKey && !failedOnce.has(body.idempotencyKey)) {
      failedOnce.add(body.idempotencyKey)
      return HttpResponse.json({ error: '写入失败（模拟）' }, { status: 500 })
    }

    // 乐观锁：先到者生效，后到者冲突
    if (body.basedOnSeq !== undefined && issue.versionSeq !== body.basedOnSeq) {
      return HttpResponse.json(
        { conflict: { issueKey: issue.key, field: 'versionSeq', expected: String(body.basedOnSeq), actual: String(issue.versionSeq), message: `${issue.key} 已被他人处理（版本 ${body.basedOnSeq} → ${issue.versionSeq}）` } },
        { status: 409 },
      )
    }

    const result = normalizeResult(body.result)
    const snap = snapshotForVersion(snapshots, body.basedOnVersion ?? issue.version, issue.key, now())
    if (!snapshots.some((s) => s.id === snap.id)) snapshots = [...snapshots, snap]
    const record = {
      id: `RT-${Date.now()}`,
      actor: '当前用户',
      result,
      note: body.note,
      at: '刚刚',
      environment: body.environment,
      basedOnVersion: body.basedOnVersion ?? issue.version,
      evidenceHash: body.evidenceHash || evidenceHashOf(issue),
      conclusionId: '',
      idempotencyKey: body.idempotencyKey,
    }
    const next = applyRetest(issue, record, snap.id, now())
    issues = issues.map((item) => (item.key === params.key ? next : item))
    if (body.idempotencyKey) processedIdempotency.set(body.idempotencyKey, next)
    return HttpResponse.json(next)
  }),

  http.post('/api/issues/bulk-assign', async ({ request }) => {
    const body = (await request.json()) as { keys: string[]; team: string; owner: string; dueDate: string; priority: string }
    issues = issues.map((issue) =>
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

export { issues }
