import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Alert, Button, Checkbox, Select, Space, Table, Tag, Typography, message } from 'antd'
import { RollbackOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { acceptVersion, fetchVersions, rollbackVersion } from '../api/reviewApi'

export default function VersionsPage() {
  const { refetch: refetchIssues } = useIssues()
  const issues = useWorkspaceStore((state) => state.issues)
  const { data: snapshots = [], refetch: refetchSnapshots } = useQuery({ queryKey: ['versions'], queryFn: fetchVersions })
  const [accepted, setAccepted] = useState<string[]>([])
  const [affected, setAffected] = useState<string[]>([])

  const rows = snapshots.map((snap) => {
    const issue = issues.find((i) => i.key === snap.issueKey)
    return { ...snap, issueTitle: issue?.title, issueStatus: issue?.status }
  })

  const toggle = (key: string, checked: boolean) => {
    setAccepted((current) => (checked ? [...new Set([...current, key])] : current.filter((item) => item !== key)))
  }

  const acceptSelected = async () => {
    for (const id of accepted) {
      const snap = snapshots.find((s) => s.id === id)
      if (!snap) continue
      await acceptVersion({ issueKey: snap.issueKey, version: snap.version, baseline: snap.baseline, candidate: snap.candidate, field: snap.field, risk: snap.risk })
    }
    message.success(`已接受 ${accepted.length} 项变更并生成新修订`)
    setAccepted([])
    refetchSnapshots()
  }

  const rollback = async (snapshotId: string) => {
    const res = await rollbackVersion(snapshotId)
    message.success(`已回退版本，${res.affected.length} 条问题的相关结论立即失效并按当前记录重算`)
    setAffected(res.affected)
    await refetchIssues()
    refetchSnapshots()
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">VERSION DIFF / 版本差异</p>
          <h1>比较整改版本并部分采纳</h1>
          <p className="muted">可选择接受单一变更生成新修订；版本回退将使依据该版本的结论立即失效并重算。</p>
        </div>
        <Space>
          <Select defaultValue="v4.18" options={[{ value: 'v4.18' }, { value: 'v4.17' }]} style={{ width: 110 }} />
          <span>对比</span>
          <Select defaultValue="v4.18-rc2" options={[{ value: 'v4.18-rc2' }, { value: 'v4.19-dev' }]} style={{ width: 130 }} />
          <Button type="primary" disabled={!accepted.length} onClick={acceptSelected}>接受所选变更</Button>
        </Space>
      </div>

      {affected.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="版本回退已生效"
          description={<>受影响问题：{affected.map((k) => <Tag key={k} color="warning">{k}</Tag>)}相关结论已失效并按当前记录重算。</>}
        />
      )}

      <div className="panel">
        <div className="panel-head"><h3>变更清单</h3><Tag color="blue">基线 v4.18</Tag></div>
        <Table
          rowKey="id"
          dataSource={rows}
          pagination={false}
          scroll={{ x: 1000 }}
          columns={[
            { title: '采纳', width: 70, render: (_, record) => <Checkbox checked={accepted.includes(record.id)} onChange={(event) => toggle(record.id, event.target.checked)} /> },
            { title: '问题', dataIndex: 'issueKey', width: 120, render: (value, record) => <div><Typography.Text strong>{value}</Typography.Text><div style={{ fontSize: 11, color: '#74818a' }}>{record.issueTitle}</div></div> },
            { title: '变更项', dataIndex: 'field', width: 110 },
            { title: '当前基线', dataIndex: 'baseline', width: 240, render: (value) => <span style={{ color: '#9a4d35' }}>{value}</span> },
            { title: '候选版本', dataIndex: 'candidate', width: 280, render: (value) => <span style={{ color: '#26705a' }}>{value}</span> },
            { title: '依据版本', dataIndex: 'version', width: 110, render: (value) => <Tag>{value}</Tag> },
            { title: '风险', dataIndex: 'risk', width: 70, render: (value) => <Tag color={value === '中' ? 'gold' : 'green'}>{value}</Tag> },
            { title: '状态', width: 90, render: (_, record) => (record.rolledBackAt ? <Tag color="default">已回退</Tag> : <Tag color="success">已接受</Tag>) },
            {
              title: '操作',
              width: 110,
              render: (_, record) => (
                <Button size="small" danger icon={<RollbackOutlined />} disabled={!!record.rolledBackAt} onClick={() => rollback(record.id)}>回退版本</Button>
              ),
            },
          ]}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <div className="panel"><div className="panel-head"><h3>被接受变更的影响</h3></div><div style={{ padding: 16 }}><Typography.Paragraph>版本回退后，依据该版本的复测结论立即失效，问题状态按当前有效结论重算；无有效结论时回到「待复测」。</Typography.Paragraph><Space><Tag color="green">结论可回溯</Tag><Tag color="blue">状态按当前记录重算</Tag></Space></div></div>
        <div className="panel"><div className="panel-head"><h3>版本操作历史</h3></div><div style={{ padding: 16 }}><div className="timeline-item"><strong>v4.18-rc2 创建</strong><div>仅包含无障碍修复，不影响业务功能。</div><span className="muted">何沐 · 09-28 16:20</span></div></div></div>
      </div>
    </section>
  )
}
