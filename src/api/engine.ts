import type {
  BatchConflict,
  BatchConflictResponse,
  BatchItemInput,
  BatchSubmitBody,
  BatchSubmitResult,
  ConclusionCycle,
  Issue,
  IssueStatus,
  RetestDraft,
  RetestRecord,
} from './types'
import { bootstrapChain } from './seed'

/* ---------------------------------- 时间 ---------------------------------- */

export function nowLabel(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

let seq = 0
export function nextId(prefix: string): string {
  seq += 1
  return `${prefix}-${Date.now()}-${seq}`
}

/* -------------------------------- 版本比较 --------------------------------- */

/** v4.18.3 / v4.19-rc1 → 可比较元组；rc 视为同版本号下的低序号 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = v.trim().replace(/^v/i, '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-rc(\d+))?$/)
    if (!m) return [0, 0, 0, 0]
    return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0), m[4] ? Number(m[4]) : 1_000_000]
  }
  const pa = parse(a)
  const pb = parse(b)
  for (let i = 0; i < 4; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

/* ------------------------------ 旧数据升级 -------------------------------- */

/** 旧数据升级：没有结论链就补齐首版（首条复测记录对应的结论周期） */
export function upgradeIssue(issue: Issue): Issue {
  if (issue.chain && issue.chain.length > 0 && typeof issue.revision === 'number') return issue
  const { chain, records, revision } = bootstrapChain(issue)
  return { ...issue, chain, retestRecords: records, revision: issue.revision ?? revision }
}

/* -------------------------------- 服务端状态 -------------------------------- */

export type ServerState = {
  issues: Issue[]
  drafts: RetestDraft[]
  claims: Record<string, { actor: string; at: string }>
  batches: Record<string, { at: string; recordIds: string[]; writtenKeys: string[] }>
  runtime: { rollbackVersion: string | null; expiredKeys: string[] }
  faultArmed: boolean
}

export function createServerState(seed: Issue[]): ServerState {
  return {
    issues: seed.map(upgradeIssue),
    drafts: [],
    claims: {},
    batches: {},
    runtime: { rollbackVersion: null, expiredKeys: [] },
    faultArmed: false,
  }
}

const statusByVerdict: Record<string, IssueStatus> = { 通过: '已通过', 退回: '已退回', 不适用: '不适用' }

function lastCycle(issue: Issue): ConclusionCycle | undefined {
  return issue.chain[issue.chain.length - 1]
}

function pushHistory(issue: Issue, action: string, detail: string, actor = '系统') {
  issue.history.push({ at: nowLabel(), actor, action, detail })
}

/**
 * 按当前运行时口径重算单条问题：
 * 版本回退或证据过期 → 相关通过/不适用结论立即失效（保留不删），
 * 紧随其后新开「失效重开」周期，状态按当前记录重算为待复测。
 * 失效是一次性事件：valid 翻转后幂等，不会重复开周期。
 */
export function recomputeIssue(issue: Issue, runtime: ServerState['runtime']): Issue {
  const next: Issue = { ...issue, chain: issue.chain.map((cycle) => ({ ...cycle })), history: [...issue.history] }
  const invalidate = (cycle: ConclusionCycle, reason: '版本回退' | '证据过期', detail: string) => {
    cycle.valid = false
    cycle.invalidReason = reason
    cycle.invalidatedAt = nowLabel()
    pushHistory(next, '结论失效', `${detail}，周期 #${cycle.index + 1} 的「${cycle.verdict}」结论立即失效并保留，按当前记录重算。`)
    const successorIndex = cycle.index + 1
    if (!next.chain.some((item) => item.index === successorIndex)) {
      next.chain.push({
        index: successorIndex,
        openedAt: nowLabel(),
        openedBy: '系统',
        openReason: '失效重开',
        openedVersion: runtime.rollbackVersion ?? next.version,
        openedRevision: next.revision,
        valid: true,
      })
      pushHistory(next, '失效重开', `依据变化后新开周期 #${successorIndex + 1}，等待复测员按当前版本重新结论。`)
    }
  }

  next.chain.forEach((cycle) => {
    if (!cycle.valid || !cycle.verdict || (cycle.verdict !== '通过' && cycle.verdict !== '不适用') || !cycle.conclusionVersion) return
    if (runtime.rollbackVersion && compareVersions(runtime.rollbackVersion, cycle.conclusionVersion) < 0) {
      invalidate(cycle, '版本回退', `线上基线回退至 ${runtime.rollbackVersion}，早于结论版本 ${cycle.conclusionVersion}`)
    } else if (runtime.expiredKeys.includes(next.key)) {
      invalidate(cycle, '证据过期', `该问题的结论证据（${next.evidence}）已过期，周期 #${cycle.index + 1} 结论失去依据`)
    }
  })

  const current = lastCycle(next)
  if (current) {
    if (current.verdict) {
      next.status = statusByVerdict[current.verdict]
    } else if (current.index > 0 || next.retestRecords.some((record) => record.cycleIndex === 0)) {
      // 回归 / 退回 / 失效后新开的空周期 → 待复测；首周期且无记录保留原状态
      next.status = '待复测'
    }
  }
  return next
}

export function recomputeAll(state: ServerState): void {
  state.issues = state.issues.map((issue) => recomputeIssue(issue, state.runtime))
}

/* ------------------------------ 开发提交候选版本 ----------------------------- */

export function submitDevCandidate(state: ServerState, key: string, input: { version: string; fixNote?: string; retestEnv?: string; actor: string }): Issue | null {
  const issue = state.issues.find((item) => item.key === key)
  if (!issue) return null
  const latest = lastCycle(issue)
  const priorVerdict = latest?.verdict
  const next: Issue = {
    ...issue,
    version: input.version,
    fixNote: input.fixNote ?? issue.fixNote,
    retestEnv: input.retestEnv ?? issue.retestEnv,
    status: '待复测',
    revision: issue.revision + 1,
    history: [...issue.history],
  }
  if (latest && !latest.verdict) {
    // 已有打开中的周期（失效重开等），直接复用，仅推进修订号
  } else if (latest && (priorVerdict === '退回' || priorVerdict === '通过' || priorVerdict === '不适用')) {
    const reason = priorVerdict === '退回' ? '退回复测' : '回归重开'
    next.chain = [...next.chain, {
      index: latest.index + 1,
      openedAt: nowLabel(),
      openedBy: input.actor,
      openReason: reason,
      openedVersion: input.version,
      openedRevision: next.revision,
      valid: true,
      regressionFrom: reason === '回归重开' ? latest.index : undefined,
    }]
    pushHistory(next, reason === '回归重开' ? '回归重开' : '退回重开', `候选版本 ${input.version} 提交复测，沿用原问题 ${key}，历史通过记录保留，新开周期 #${latest.index + 2}。`, input.actor)
  }
  pushHistory(next, '开发提交复测', `${input.actor} 提交候选版本 ${input.version}，问题修订号 ${issue.revision} → ${next.revision}。`, input.actor)
  state.issues = state.issues.map((item) => (item.key === key ? recomputeIssue(next, state.runtime) : item))
  return state.issues.find((item) => item.key === key)!
}

/* --------------------------------- 草稿 ---------------------------------- */

export function saveDraft(state: ServerState, draft: Omit<RetestDraft, 'id' | 'createdAt'>): RetestDraft {
  const full: RetestDraft = { ...draft, id: nextId('DR'), createdAt: nowLabel() }
  state.drafts = [full, ...state.drafts]
  return full
}

export function removeDraft(state: ServerState, id: string): void {
  state.drafts = state.drafts.filter((draft) => draft.id !== id)
}

/* -------------------------------- 并发抢占 --------------------------------- */

export function claim(state: ServerState, key: string, actor: string): { held: boolean; claim?: ServerState['claims'][string] } {
  const existing = state.claims[key]
  if (existing && existing.actor !== actor) return { held: true, claim: existing }
  state.claims[key] = { actor, at: nowLabel() }
  return { held: false, claim: state.claims[key] }
}

export function releaseClaim(state: ServerState, key: string): void {
  delete state.claims[key]
}

/* ------------------------------ 批量复测提交 ------------------------------- */

type SubmitOutcome =
  | { ok: true; result: BatchSubmitResult }
  | { ok: false; status: number; body: BatchConflictResponse }

/**
 * 批量提交：写入前一起校验依据，有一条变了整批不写入并列出冲突。
 * 同一 batchId 重试只回放首次结果，绝不重复追加记录。
 */
export function submitBatch(state: ServerState, body: BatchSubmitBody): SubmitOutcome {
  // 幂等：写入失败后按原批次重试，直接回放
  const stored = state.batches[body.batchId]
  if (stored) {
    return {
      ok: true,
      result: {
        batchId: body.batchId,
        written: stored.writtenKeys.map((key) => state.issues.find((issue) => issue.key === key)!).filter(Boolean),
        idempotent: true,
        drafts: state.drafts.filter((draft) => draft.batchId === body.batchId),
      },
    }
  }

  // 模拟写入故障：发生在任何写入之前，因此重试安全
  if (state.faultArmed) {
    state.faultArmed = false
    throw new Error('SIMULATED_WRITE_FAULT')
  }

  const conflicts: BatchConflict[] = []
  const seen = new Set<string>()

  body.items.forEach((item) => {
    const add = (code: BatchConflict['code'], message: string, expected?: unknown, actual?: unknown) =>
      conflicts.push({ key: item.key, code, message, expected, actual })

    if (seen.has(item.key)) {
      add('duplicate-in-batch', '同一问题在本批次中出现了两次')
      return
    }
    seen.add(item.key)

    const issue = state.issues.find((candidate) => candidate.key === item.key)
    if (!issue) {
      add('not-found', '问题不存在或已被删除')
      return
    }
    const holder = state.claims[item.key]
    if (holder && holder.actor !== body.actor) {
      add('concurrent', `${holder.actor} 已先领取该问题，本条只能留存草稿`, holder.actor, body.actor)
    }
    if (issue.revision !== item.basisRevision) {
      add('basis-changed', `问题修订号已变化（依据 ${item.basisRevision}，当前 ${issue.revision}），请刷新后重新核对`, item.basisRevision, issue.revision)
    }
    if (issue.version !== item.basisVersion) {
      add('version-mismatch', `问题版本已变化（依据 ${item.basisVersion}，当前 ${issue.version}）`, item.basisVersion, issue.version)
    }
    if (issue.evidence !== item.evidenceFp) {
      add('evidence-changed', '证据链接已更换，原依据失效，请核对新证据', item.evidenceFp, issue.evidence)
    }
    if (state.runtime.expiredKeys.includes(item.key)) {
      add('evidence-expired', '该问题的结论证据已被标记过期，不能据此提交结论')
    }
  })

  if (conflicts.length > 0) {
    // 整批不写入；每条都留草稿
    const drafts = body.items.map((item: BatchItemInput) =>
      saveDraft(state, {
        key: item.key,
        actor: body.actor,
        verdict: item.verdict,
        note: item.note,
        environment: body.environment,
        testVersion: body.testVersion,
        basisRevision: item.basisRevision,
        basisVersion: item.basisVersion,
        evidenceFp: item.evidenceFp,
        batchId: body.batchId,
        reason: conflicts.filter((conflict) => conflict.key === item.key).map((conflict) => conflict.message).join('；') || '整批存在其他冲突条目',
      }),
    )
    return { ok: false, status: 409, body: { error: 'conflict', batchId: body.batchId, conflicts, drafts } }
  }

  // 依据全部一致：整批原子写入
  const recordIds: string[] = []
  const writtenKeys: string[] = []
  const touched: Issue[] = []

  body.items.forEach((item) => {
    const issue = state.issues.find((candidate) => candidate.key === item.key)!
    const record: RetestRecord = {
      id: nextId('RT'),
      actor: body.actor,
      result: item.verdict,
      note: item.note,
      at: nowLabel(),
      atIso: new Date().toISOString(),
      environment: body.environment,
      testVersion: body.testVersion,
      basisRevision: item.basisRevision,
      evidenceFp: item.evidenceFp,
      batchId: body.batchId,
    }

    let target = lastCycle(issue)
    const chain = issue.chain.map((cycle) => ({ ...cycle }))
    if (!target || target.verdict) {
      const reason = !target ? '首次复测' : target.verdict === '退回' ? '退回复测' : '回归重开'
      const opened: ConclusionCycle = {
        index: target ? target.index + 1 : 0,
        openedAt: nowLabel(),
        openedBy: body.actor,
        openReason: reason,
        openedVersion: issue.version,
        openedRevision: issue.revision,
        valid: true,
        regressionFrom: target && reason === '回归重开' ? target.index : undefined,
      }
      chain.push(opened)
      target = opened
    }
    record.cycleIndex = target.index
    target.verdict = item.verdict
    target.concludedAt = record.at
    target.concludedBy = body.actor
    target.conclusionVersion = body.testVersion

    const updated: Issue = {
      ...issue,
      status: statusByVerdict[item.verdict],
      retestEnv: body.environment,
      retestRecords: [...issue.retestRecords, record],
      revision: issue.revision + 1,
      chain,
      history: [
        ...issue.history,
        {
          at: record.at,
          actor: `${body.actor} / 复测员`,
          action: `复测${item.verdict}`,
          detail:
            item.verdict === '退回' && chain.slice(0, -1).some((cycle) => cycle.verdict === '通过')
              ? `周期 #${target.index + 1} 退回：检出回归，沿用 ${issue.key}，原通过记录保留。${item.note}`
              : `周期 #${target.index + 1} 结论「${item.verdict}」，结论版本 ${body.testVersion}。${item.note}`,
        },
      ],
    }
    recordIds.push(record.id)
    writtenKeys.push(issue.key)
    touched.push(recomputeIssue(updated, state.runtime))
    releaseClaim(state, issue.key)
  })

  state.issues = state.issues.map((issue) => touched.find((item) => item.key === issue.key) ?? issue)
  state.batches[body.batchId] = { at: nowLabel(), recordIds, writtenKeys }

  return {
    ok: true,
    result: {
      batchId: body.batchId,
      written: writtenKeys.map((key) => state.issues.find((issue) => issue.key === key)!),
    },
  }
}

/* ------------------------------ 结论链视图派生 ------------------------------ */

export type ChainState = '回归' | '结论失效' | '已退回' | '已通过' | '待复测' | '处理中'

export function chainState(issue: Issue): ChainState {
  const current = lastCycle(issue)
  if (!current) return '处理中'
  const priorPass = issue.chain.slice(0, -1).some((cycle) => cycle.verdict === '通过')
  if (!current.verdict) {
    if (issue.chain.slice(0, -1).some((cycle) => !cycle.valid)) return '结论失效'
    if (priorPass) return '回归'
    return issue.status === '待复测' ? '待复测' : '处理中'
  }
  if (current.verdict === '通过') return '已通过'
  if (current.verdict === '退回') return priorPass ? '回归' : '已退回'
  return '处理中'
}

export function chainSummary(issue: Issue): string {
  return issue.chain
    .map((cycle) => {
      const verdict = cycle.verdict ? `${cycle.verdict}${cycle.conclusionVersion ? ` ${cycle.conclusionVersion}` : ''}` : '待复测'
      const tag = !cycle.valid ? '（已失效）' : ''
      return `#${cycle.index + 1} ${verdict}${tag}`
    })
    .join(' → ')
}
