import type {
  BatchReviewItem,
  Conclusion,
  ConclusionChain,
  ConclusionInvalidation,
  Conflict,
  Issue,
  IssueStatus,
  RetestRecord,
  RetestResult,
  VersionSnapshot,
} from './types'

/** 稳定的字符串哈希，用于证据快照与版本快照比对。 */
export function hashString(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return `h${(h >>> 0).toString(36)}`
}

export function evidenceHashOf(issue: Pick<Issue, 'evidence'>): string {
  return hashString(issue.evidence || '')
}

export function snapshotHashOf(snap: Pick<VersionSnapshot, 'version' | 'baseline' | 'candidate' | 'field' | 'risk'>): string {
  return hashString([snap.version, snap.baseline, snap.candidate, snap.field, snap.risk].join('|'))
}

const resultToStatus: Record<RetestResult, IssueStatus> = { 通过: '已通过', 退回: '已退回', 不适用: '不适用' }

export function statusOfResult(result: RetestResult): IssueStatus {
  return resultToStatus[result]
}

export function createChain(issue: Issue, now: string): ConclusionChain {
  return {
    id: `CHAIN-${issue.key}`,
    issueKey: issue.key,
    rootCause: issue.rootCause,
    conclusions: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 旧数据升级：为没有结论链的问题补齐首版。
 * 依据已有复测记录逐条生成结论，末条作为当前有效结论，其余标记为被新复测取代。
 */
export function ensureChain(issue: Issue, now: string): Issue {
  if (issue.chain && issue.chain.conclusions.length > 0) return issue
  const chainId = `CHAIN-${issue.key}`
  const eHash = evidenceHashOf(issue)
  const records = issue.retestRecords ?? []
  const conclusions: Conclusion[] = records.map((rec, idx) => {
    const seq = idx + 1
    const isHead = idx === records.length - 1
    return {
      id: rec.conclusionId ?? `C-${issue.key}-${seq}`,
      chainId,
      issueKey: issue.key,
      rootCause: issue.rootCause,
      seq,
      result: rec.result,
      status: isHead ? '有效' : '失效',
      version: rec.basedOnVersion ?? issue.version,
      evidenceHash: rec.evidenceHash || eHash,
      retestRecordId: rec.id,
      decidedAt: rec.at,
      invalidatedAt: isHead ? undefined : rec.at,
      invalidatedBy: isHead ? undefined : '新复测',
    }
  })
  const chain: ConclusionChain = {
    id: chainId,
    issueKey: issue.key,
    rootCause: issue.rootCause,
    conclusions,
    version: 1,
    createdAt: issue.history[0]?.at ?? now,
    updatedAt: now,
  }
  const status = conclusions.length ? statusOfResult(conclusions[conclusions.length - 1].result) : issue.status
  return {
    ...issue,
    chain,
    status,
    versionSeq: issue.versionSeq ?? 1,
    updatedAt: issue.updatedAt ?? now,
  }
}

/**
 * 追加一条复测记录并生成结论。
 * 回归（此前通过、本次退回）沿用原问题与原通过记录，仅把旧结论标记为「回归」失效。
 */
export function applyRetest(issue: Issue, rec: RetestRecord, snapshotId: string | undefined, now: string): Issue {
  const chain = issue.chain ?? createChain(issue, now)
  const seq = chain.conclusions.length + 1
  const conclusion: Conclusion = {
    id: `C-${issue.key}-${seq}-${hashString(rec.id)}`,
    chainId: chain.id,
    issueKey: issue.key,
    rootCause: issue.rootCause,
    seq,
    result: rec.result,
    status: '有效',
    version: rec.basedOnVersion,
    evidenceHash: rec.evidenceHash || evidenceHashOf(issue),
    versionSnapshotId: snapshotId,
    retestRecordId: rec.id,
    decidedAt: rec.at,
  }
  const prevHead = [...chain.conclusions].reverse().find((c) => c.status === '有效')
  const conclusions = chain.conclusions.map((c) => {
    if (prevHead && c.id === prevHead.id) {
      const regression = prevHead.result === '通过' && rec.result === '退回'
      const invalidatedBy: ConclusionInvalidation = regression ? '回归' : '新复测'
      return { ...c, status: '失效' as const, invalidatedAt: now, invalidatedBy }
    }
    return c
  })
  conclusions.push(conclusion)
  const newChain: ConclusionChain = { ...chain, conclusions, version: chain.version + 1, updatedAt: now }
  return {
    ...issue,
    chain: newChain,
    retestRecords: [...issue.retestRecords, { ...rec, conclusionId: conclusion.id }],
    status: statusOfResult(rec.result),
    retestEnv: rec.environment,
    versionSeq: (issue.versionSeq ?? 1) + 1,
    updatedAt: now,
  }
}

/**
 * 按当前记录重算结论链：
 * - 依据版本回退或证据过期的结论立即失效；
 * - 依据仍然成立的结论中取最新一条作为当前有效结论；
 * - 没有任何依据成立时，状态回退为「待复测」。
 */
export function recompute(issue: Issue, snapshots: VersionSnapshot[], now: string): { issue: Issue; changed: boolean } {
  if (!issue.chain) return { issue, changed: false }
  const eHash = evidenceHashOf(issue)
  const rolledBackVersions = new Set(snapshots.filter((s) => s.rolledBackAt).map((s) => s.version))
  let changed = false
  const conclusions = issue.chain.conclusions.map((c) => {
    const basisRolledBack = rolledBackVersions.has(c.version)
    const evidenceExpired = c.evidenceHash !== eHash
    if (basisRolledBack) {
      if (c.status !== '失效' || c.invalidatedBy !== '版本回退') changed = true
      return { ...c, status: '失效' as const, invalidatedAt: now, invalidatedBy: '版本回退' as const }
    }
    if (evidenceExpired) {
      if (c.status !== '失效' || c.invalidatedBy !== '证据过期') changed = true
      return { ...c, status: '失效' as const, invalidatedAt: now, invalidatedBy: '证据过期' as const }
    }
    if (c.status === '失效') {
      changed = true
      const { invalidatedAt: _ia, invalidatedBy: _ib, ...rest } = c
      return { ...rest, status: '有效' as const, reinstatedAt: now }
    }
    return c
  })
  const eligible = conclusions.filter((c) => c.status === '有效').sort((a, b) => b.seq - a.seq)
  const head = eligible[0]
  const finalConclusions = conclusions.map((c) => {
    if (c.status === '有效' && (!head || c.id !== head.id)) {
      changed = true
      const reason: Conclusion['invalidatedBy'] = head && head.result === '退回' && c.result === '通过' ? '回归' : '新复测'
      return { ...c, status: '失效' as const, invalidatedAt: now, invalidatedBy: reason }
    }
    return c
  })
  const status: IssueStatus = head ? statusOfResult(head.result) : '待复测'
  if (status !== issue.status) changed = true
  return {
    issue: {
      ...issue,
      chain: { ...issue.chain, conclusions: finalConclusions, version: issue.chain.version + (changed ? 1 : 0), updatedAt: now },
      status,
      updatedAt: now,
    },
    changed,
  }
}

/**
 * 批量提交前一起校验依据：乐观锁版本号、证据哈希、依据版本是否已回退。
 * 任一依据变化即返回冲突列表，调用方据此整批不写入。
 */
export function validateBatch(
  issues: Issue[],
  items: Array<Pick<BatchReviewItem, 'issueKey' | 'basedOnSeq' | 'evidenceHash' | 'basedOnVersion'>>,
  snapshots: VersionSnapshot[],
): Conflict[] {
  const conflicts: Conflict[] = []
  for (const item of items) {
    const issue = issues.find((i) => i.key === item.issueKey)
    if (!issue) {
      conflicts.push({ issueKey: item.issueKey, field: 'issue', expected: '存在', actual: '不存在', message: `问题 ${item.issueKey} 不存在` })
      continue
    }
    if (issue.versionSeq !== item.basedOnSeq) {
      conflicts.push({
        issueKey: item.issueKey,
        field: 'versionSeq',
        expected: String(item.basedOnSeq),
        actual: String(issue.versionSeq),
        message: `${item.issueKey} 已被他人处理（版本 ${item.basedOnSeq} → ${issue.versionSeq}）`,
      })
    }
    const currentEHash = evidenceHashOf(issue)
    if (item.evidenceHash && item.evidenceHash !== currentEHash) {
      conflicts.push({
        issueKey: item.issueKey,
        field: 'evidence',
        expected: item.evidenceHash,
        actual: currentEHash,
        message: `${item.issueKey} 证据已变更，原结论依据过期`,
      })
    }
    const rolledBack = snapshots.some((s) => s.rolledBackAt && s.version === item.basedOnVersion)
    if (rolledBack) {
      conflicts.push({
        issueKey: item.issueKey,
        field: 'version',
        expected: item.basedOnVersion,
        actual: '已回退',
        message: `${item.issueKey} 依据版本 ${item.basedOnVersion} 已回退`,
      })
    }
  }
  return conflicts
}

/** 依据版本号查找或创建版本快照（复测依据）。 */
export function snapshotForVersion(snapshots: VersionSnapshot[], version: string, issueKey: string, now: string): VersionSnapshot {
  const existing = snapshots.find((s) => s.version === version && s.issueKey === issueKey)
  if (existing) return existing
  const snap: VersionSnapshot = {
    id: `SNAP-${issueKey}-${version}`,
    issueKey,
    version,
    baseline: version,
    candidate: version,
    field: '复测依据版本',
    risk: '低',
    hash: snapshotHashOf({ version, baseline: version, candidate: version, field: '复测依据版本', risk: '低' }),
    acceptedAt: now,
  }
  return snap
}
