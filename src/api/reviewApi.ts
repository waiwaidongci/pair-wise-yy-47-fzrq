import axios from 'axios'
import type { BatchReviewItem, Conflict, Issue, RetestResult, VersionSnapshot } from './types'

export type ReviewInput = {
  result: '已通过' | '已退回' | '不适用'
  note: string
  environment: string
  basedOnSeq: number
  evidenceHash: string
  basedOnVersion: string
  idempotencyKey: string
  simulateFail?: boolean
}

export type BatchReviewInput = {
  batchId: string
  items: Array<BatchReviewItem & { result: RetestResult }>
  simulateFail?: boolean
}

export async function fetchVersions(): Promise<VersionSnapshot[]> {
  return (await axios.get<VersionSnapshot[]>('/api/versions')).data
}

export async function acceptVersion(body: Omit<VersionSnapshot, 'id' | 'hash' | 'acceptedAt'>): Promise<VersionSnapshot> {
  return (await axios.post<VersionSnapshot>('/api/versions/accept', body)).data
}

export async function rollbackVersion(snapshotId: string): Promise<{ snapshotId: string; affected: string[] }> {
  return (await axios.post('/api/versions/rollback', { snapshotId })).data
}

export async function reviewIssue(key: string, body: ReviewInput): Promise<Issue> {
  return (await axios.post<Issue>(`/api/issues/${key}/review`, body)).data
}

export async function reviewBatch(body: BatchReviewInput): Promise<{ batchId: string; updated: number; keys: string[]; idempotent?: boolean }> {
  return (await axios.post('/api/issues/review-batch', body)).data
}

export async function simulateConcurrent(key: string): Promise<Issue> {
  return (await axios.post<Issue>(`/api/issues/${key}/simulate-concurrent`)).data
}

export async function expireEvidence(key: string): Promise<Issue> {
  return (await axios.post<Issue>(`/api/issues/${key}/expire-evidence`)).data
}

export function isConflict(err: unknown): err is { response: { status: 409; data: { conflict?: Conflict; conflicts?: Conflict[] } } } {
  return !!err && typeof err === 'object' && (err as { response?: { status?: number } }).response?.status === 409
}
