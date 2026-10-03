export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

/** 复测结论：通过 / 退回 / 不适用 */
export type RetestVerdict = '通过' | '退回' | '不适用'

/** 结论失效原因：版本回退 / 证据过期；回归本身不失效历史结论，而是新开周期 */
export type InvalidReason = '版本回退' | '证据过期'

/** 结论周期打开原因：首次复测 / 退回后复测 / 回归重开 / 失效重开 */
export type CycleOpenReason = '首次复测' | '退回复测' | '回归重开' | '失效重开'

export type RetestRecord = {
  id: string
  actor: string
  result: RetestVerdict
  note: string
  at: string
  /** ISO 时间，用于有效期与批次幂等计算 */
  atIso?: string
  /** 复测环境：浏览器 / 辅助技术 / 被测版本 */
  environment?: string
  /** 复测时被测候选版本 */
  testVersion?: string
  /** 提交时依据的问题修订号，乐观锁 */
  basisRevision?: number
  /** 提交时证据指纹 */
  evidenceFp?: string
  /** 所属批次（幂等重试依据） */
  batchId?: string
  /** 所属结论周期序号（从 0 开始） */
  cycleIndex?: number
}

/**
 * 结论周期：同一条问题的一个「打开 → 结论（通过/退回/不适用）」片段。
 * 回归 / 失效后新开周期，旧周期及其通过记录永久保留，形成可回溯结论链。
 */
export type ConclusionCycle = {
  index: number
  openedAt: string
  openedBy: string
  openReason: CycleOpenReason
  /** 周期打开时问题所处版本；回退重开时为回退后版本 */
  openedVersion: string
  /** 周期打开时的问题修订号 */
  openedRevision: number
  verdict?: RetestVerdict
  concludedAt?: string
  concludedBy?: string
  /** 结论对应的版本，版本差异按此与比较版本计算 */
  conclusionVersion?: string
  /** 触发本周期的回归来源周期（仅 openReason=回归重开） */
  regressionFrom?: number
  /** 结论是否仍有效（失效后保留为 false，不删除） */
  valid: boolean
  invalidReason?: InvalidReason
  invalidatedAt?: string
}

export type Issue = {
  key: string
  title: string
  site: string
  version: string
  wcag: string[]
  issueType: string
  impact: '致命' | '严重' | '中等' | '轻微'
  affected: string
  reproduction: string
  evidence: string
  rootCause: string
  status: IssueStatus
  priority: 'P0' | 'P1' | 'P2' | 'P3'
  team: string
  owner: string
  dueDate: string
  mergedKeys: string[]
  fixNote?: string
  retestEnv?: string
  retestRecords: RetestRecord[]
  history: Array<{ at: string; actor: string; action: string; detail: string }>
  /** 乐观锁修订号：任何写入 +1，复测提交必须携带当前修订号 */
  revision: number
  /** 结论链（旧数据升级时补齐首版） */
  chain: ConclusionCycle[]
}

/** 后到者的复测提交，以草稿留存 */
export type RetestDraft = {
  id: string
  key: string
  actor: string
  verdict: RetestVerdict
  note: string
  environment: string
  testVersion: string
  basisRevision: number
  basisVersion: string
  evidenceFp: string
  batchId?: string
  reason: string
  createdAt: string
}

/** 提交前依据校验冲突类型 */
export type ConflictCode = 'not-found' | 'basis-changed' | 'version-mismatch' | 'evidence-changed' | 'evidence-expired' | 'duplicate-in-batch' | 'concurrent'

export type BatchConflict = {
  key: string
  code: ConflictCode
  message: string
  expected?: unknown
  actual?: unknown
}

export type BatchItemInput = {
  key: string
  verdict: RetestVerdict
  note: string
  basisRevision: number
  basisVersion: string
  evidenceFp: string
}

export type BatchSubmitBody = {
  batchId: string
  actor: string
  environment: string
  testVersion: string
  items: BatchItemInput[]
}

export type BatchSubmitResult = {
  batchId: string
  written: Issue[]
  /** 幂等命中：同一批次重试，直接回放首次结果，不重复追加记录 */
  idempotent?: boolean
  /** 后到者留存的草稿（并发冲突时） */
  drafts?: RetestDraft[]
}

export type BatchConflictResponse = {
  error: 'conflict'
  batchId: string
  conflicts: BatchConflict[]
  /** 整批不写入时回传的整批草稿 */
  drafts: RetestDraft[]
}

export type RuntimeState = {
  /** 模拟回退基线版本（低于已通过结论版本即触发回退失效） */
  rollbackVersion: string | null
  /** 被标记为证据过期的问题 key */
  expiredKeys: string[]
  /** 下一批写入是否故障（消费一次），用于演示按原批次重试 */
  faultArmed: boolean
}
