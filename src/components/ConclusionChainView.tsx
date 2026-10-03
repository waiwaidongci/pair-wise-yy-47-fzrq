import { Tag, Typography } from 'antd'
import type { Conclusion } from '../api/types'

const resultColor: Record<string, string> = { 通过: 'success', 退回: 'error', 不适用: 'default' }
const statusColor: Record<string, string> = { 有效: 'success', 失效: 'default' }

export default function ConclusionChainView({ conclusions }: { conclusions: Conclusion[] }) {
  if (!conclusions.length) return <Typography.Text type="secondary">暂无结论，复测后生成首版结论链。</Typography.Text>
  return (
    <div>
      {conclusions.map((c) => (
        <div className="timeline-item" key={c.id} style={{ paddingBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Tag color="blue">结论 C{c.seq}</Tag>
            <Tag color={resultColor[c.result]}>{c.result}</Tag>
            <Tag color={statusColor[c.status]}>{c.status}</Tag>
            {c.versionSnapshotId && <Tag>{c.version}</Tag>}
          </div>
          <div style={{ marginTop: 4 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              依据版本 {c.version} · 证据快照 <Typography.Text code style={{ fontSize: 11 }}>{c.evidenceHash}</Typography.Text>
            </Typography.Text>
          </div>
          {c.status === '失效' && c.invalidatedBy && (
            <div style={{ marginTop: 2 }}>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                已于 {c.invalidatedAt} 因「{c.invalidatedBy}」失效
                {c.invalidatedBy === '版本回退' || c.invalidatedBy === '证据过期' ? '，按当前记录重算后不再作为结论依据。' : '，由后续复测取代。'}
              </Typography.Text>
            </div>
          )}
          {c.reinstatedAt && c.status === '有效' && (
            <div><Typography.Text type="secondary" style={{ fontSize: 11 }}>于 {c.reinstatedAt} 依据恢复重新生效</Typography.Text></div>
          )}
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>{c.decidedAt}</Typography.Text>
        </div>
      ))}
    </div>
  )
}
