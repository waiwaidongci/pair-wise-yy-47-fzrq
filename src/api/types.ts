export type IssueStatus = '待分配' | '修复中' | '待复测' | '已通过' | '已退回' | '不适用'

export type RetestResult = '通过' | '退回' | '不适用'

export type RetestRecord = {
  id: string
  actor: string
  result: RetestResult
  note: string
  at: string
  environment: string
  basedOnVersion: string
  evidenceHash: string
  conclusionId: string
  batchId?: string
  idempotencyKey?: string
}

export type ConclusionStatus = '有效' | '失效'

export type ConclusionInvalidation = '版本回退' | '证据过期' | '回归' | '新复测'

export type Conclusion = {
  id: string
  chainId: string
  issueKey: string
  rootCause: string
  seq: number
  result: RetestResult
  status: ConclusionStatus
  version: string
  evidenceHash: string
  versionSnapshotId?: string
  retestRecordId: string
  decidedAt: string
  invalidatedAt?: string
  invalidatedBy?: ConclusionInvalidation
  reinstatedAt?: string
}

export type ConclusionChain = {
  id: string
  issueKey: string
  rootCause: string
  conclusions: Conclusion[]
  version: number
  createdAt: string
  updatedAt: string
}

export type VersionSnapshot = {
  id: string
  issueKey: string
  version: string
  baseline: string
  candidate: string
  field: string
  risk: string
  hash: string
  acceptedAt: string
  rolledBackAt?: string
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
  chain?: ConclusionChain
  versionSeq?: number
  updatedAt?: string
}

export type RetestDraft = {
  id: string
  issueKey: string
  result: RetestResult
  note: string
  environment: string
  basedOnVersion: string
  basedOnSeq: number
  evidenceHash: string
  reason: '并发冲突' | '整批冲突' | '手动保存'
  conflictDetail?: string
  batchId?: string
  createdAt: string
}

export type Conflict = {
  issueKey: string
  field: string
  expected: string
  actual: string
  message: string
}

export type BatchReviewItem = {
  issueKey: string
  result: RetestResult
  note: string
  environment: string
  basedOnVersion: string
  basedOnSeq: number
  evidenceHash: string
}
