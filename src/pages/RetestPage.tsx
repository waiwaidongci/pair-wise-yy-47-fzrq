import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Radio,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { CheckCircleOutlined, ExclamationCircleOutlined, LockOutlined, ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import type { BatchConflict, Issue, RetestVerdict } from '../api/types'
import { chainState, chainSummary } from '../api/engine'
import {
  useBatchSubmit,
  useClaim,
  useDrafts,
  useDiscardDraft,
  useReleaseClaim,
  useResetDemo,
  useRuntime,
  useRuntimeActions,
} from '../api/hooks'

const TESTERS = ['苏禾', '周野']

const chainStateMeta: Record<string, { color: string; label: string }> = {
  回归: { color: 'red', label: '回归（原问题重开）' },
  结论失效: { color: 'volcano', label: '结论失效·待重测' },
  已退回: { color: 'orange', label: '已退回' },
  待复测: { color: 'gold', label: '待复测' },
  已通过: { color: 'green', label: '已通过' },
  处理中: { color: 'default', label: '处理中' },
}

type Row = {
  key: string
  /** 选中时拍下的依据快照：修订号 / 版本 / 证据指纹 */
  basisRevision: number
  basisVersion: string
  evidenceFp: string
  verdict: RetestVerdict
  note: string
}

type BatchOutcome = { kind: 'ok'; batchId: string; count: number; idempotent?: boolean } | { kind: 'conflicts'; data: { conflicts: BatchConflict[]; batchId: string } } | { kind: 'fault'; batchId: string }

export default function RetestPage() {
  useIssues()
  const issues = useWorkspaceStore((state) => state.issues)
  const [actor, setActor] = useState(TESTERS[0])
  const [rows, setRows] = useState<Row[]>([])
  const [environment, setEnvironment] = useState('Chrome 141 / VoiceOver')
  const [testVersion, setTestVersion] = useState('v4.19')
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<BatchOutcome | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [claimsHeld, setClaimsHeld] = useState<Record<string, boolean>>({})

  const batchSubmit = useBatchSubmit()
  const claimMutation = useClaim()
  const releaseClaim = useReleaseClaim()
  const draftsQuery = useDrafts()
  const discardDraft = useDiscardDraft()
  const runtimeQuery = useRuntime()
  const runtimeActions = useRuntimeActions()
  const resetDemo = useResetDemo()

  const queue = issues.filter((item) => ['待复测', '已退回'].includes(item.status))
  const drafts = draftsQuery.data ?? []
  const active = issues.find((item) => item.key === activeKey) ?? null

  const patchRow = (key: string, patch: Partial<Row>) => setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  const take = async (issue: Issue) => {
    const result = await claimMutation.mutateAsync({ key: issue.key, actor })
    if (result.held && result.claim && result.claim.actor !== actor) {
      message.warning(`${result.claim.actor} 已先领取 ${issue.key}，你只能留存草稿`)
      setClaimsHeld((current) => ({ ...current, [issue.key]: true }))
    } else {
      setClaimsHeld((current) => ({ ...current, [issue.key]: false }))
    }
    setActiveKey(issue.key)
    setRows((current) => {
      if (current.some((row) => row.key === issue.key)) return current
      return [
        ...current,
        {
          key: issue.key,
          basisRevision: issue.revision,
          basisVersion: issue.version,
          evidenceFp: issue.evidence,
          verdict: '通过',
          note: '',
        },
      ]
    })
  }

  const release = async (key: string) => {
    await releaseClaim.mutateAsync(key)
    setClaimsHeld((current) => ({ ...current, [key]: false }))
    setRows((current) => current.filter((row) => row.key !== key))
    if (activeKey === key) setActiveKey(null)
  }

  /** 按当前记录核对每条依据（提交前一起校验） */
  const conflicts = useMemo(() => {
    const map = new Map<string, BatchConflict[]>()
    rows.forEach((row) => {
      const issue = issues.find((item) => item.key === row.key)
      const list: BatchConflict[] = []
      if (!issue) list.push({ key: row.key, code: 'not-found', message: '问题不存在或已被删除' })
      else {
        if (issue.revision !== row.basisRevision) list.push({ key: row.key, code: 'basis-changed', message: `问题修订号已变化（依据 ${row.basisRevision}，当前 ${issue.revision}）`, expected: row.basisRevision, actual: issue.revision })
        if (issue.version !== row.basisVersion) list.push({ key: row.key, code: 'version-mismatch', message: `问题版本已变化（依据 ${row.basisVersion}，当前 ${issue.version}）`, expected: row.basisVersion, actual: issue.version })
        if (issue.evidence !== row.evidenceFp) list.push({ key: row.key, code: 'evidence-changed', message: '证据链接已更换，原依据失效', expected: row.evidenceFp, actual: issue.evidence })
        if (runtimeQuery.data?.expiredKeys.includes(row.key)) list.push({ key: row.key, code: 'evidence-expired', message: '结论证据已被标记过期' })
      }
      if (list.length) map.set(row.key, list)
    })
    return map
  }, [rows, issues, runtimeQuery.data])

  const refreshBasis = (key: string) => {
    const issue = issues.find((item) => item.key === key)
    if (!issue) return
    patchRow(key, { basisRevision: issue.revision, basisVersion: issue.version, evidenceFp: issue.evidence })
    message.success(`${key} 依据已按当前记录刷新`)
  }

  const submit = async (batchIdOverride?: string) => {
    if (rows.some((row) => !row.note.trim())) {
      message.error('每条复测都必须填写可验证的复测记录')
      return
    }
    if (conflicts.size > 0 && !batchIdOverride) {
      message.error('依据校验未通过：整批不会写入，请先逐条核对或刷新依据')
      return
    }
    const batchId = batchIdOverride ?? (outcome?.kind === 'fault' ? outcome.batchId : `B-${Date.now()}`)
    setSubmitting(true)
    setOutcome(null)
    try {
      const result = await batchSubmit.mutateAsync({
        batchId,
        actor,
        environment,
        testVersion,
        items: rows.map((row) => ({ key: row.key, verdict: row.verdict, note: row.note, basisRevision: row.basisRevision, basisVersion: row.basisVersion, evidenceFp: row.evidenceFp })),
      })
      setOutcome({ kind: 'ok', batchId, count: result.written.length, idempotent: result.idempotent })
      message.success(result.idempotent ? `批次 ${batchId} 幂等命中，未重复追加任何记录` : `批次 ${batchId} 已整批写入 ${result.written.length} 条`)
      setRows([])
      setActiveKey(null)
      setClaimsHeld({})
      void draftsQuery.refetch()
    } catch (error) {
      const err = error as { conflicts?: { conflicts: BatchConflict[]; batchId: string }; response?: { status?: number } }
      if (err.conflicts) {
        setOutcome({ kind: 'conflicts', data: err.conflicts })
        message.error(`整批 ${err.conflicts.conflicts.length} 处冲突，未写入任何记录，已全部留存草稿`)
        setRows([])
        setActiveKey(null)
        void draftsQuery.refetch()
      } else if (err.response?.status === 500) {
        setOutcome({ kind: 'fault', batchId })
        message.error('写入失败：服务端故障，记录未追加，可按原批次重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const columns: ColumnsType<Issue> = [
    {
      title: '问题',
      dataIndex: 'key',
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.key}</Typography.Text>
          <div>{record.title}</div>
          <Space size={4} wrap style={{ marginTop: 4 }}>
            {(() => {
              const meta = chainStateMeta[chainState(record)]
              return <Tag color={meta.color}>{meta.label}</Tag>
            })()}
            {record.chain.length > 1 && <Typography.Text type="secondary" style={{ fontSize: 11 }}>{chainSummary(record)}</Typography.Text>}
          </Space>
        </div>
      ),
    },
    { title: '版本', dataIndex: 'version', width: 110 },
    { title: '修复说明', dataIndex: 'fixNote', width: 220, render: (value) => value ?? '未提交' },
    { title: '修订号', dataIndex: 'revision', width: 80, render: (value) => <Tag>rev {value}</Tag> },
    {
      title: '领取',
      width: 110,
      render: (_, record) => {
        const inBatch = rows.some((row) => row.key === record.key)
        const held = claimsHeld[record.key]
        return inBatch ? (
          held ? (
            <Tag icon={<LockOutlined />} color="default">仅草稿</Tag>
          ) : (
            <Space size={4}><Tag color="green" icon={<CheckCircleOutlined />}>{actor}</Tag><Popconfirm title="释放领取并移出本批？" onConfirm={() => release(record.key)}><Button size="small" type="link">释放</Button></Popconfirm></Space>
          )
        ) : (
          <Button size="small" onClick={() => take(record)}>领取复测</Button>
        )
      },
    },
  ]

  const verdictColor: Record<string, string> = { 通过: 'success', 退回: 'error', 不适用: 'default' }
  const cycleColor = (cycle: Issue['chain'][number]) => {
    if (!cycle.valid) return 'red'
    return cycle.verdict === '通过' ? 'green' : cycle.verdict === '退回' ? 'red' : 'gray'
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">RETEST / 复测工作台</p>
          <h1>批量复测 · 结论链可回溯</h1>
          <p className="muted">回归沿用原问题、原通过记录保留；版本回退或证据过期结论立即失效。批量提交前统一校验依据，一条变化整批不写入。</p>
        </div>
        <Space>
          <span className="muted">当前复测员</span>
          <Radio.Group value={actor} onChange={(event) => setActor(event.target.value)} options={TESTERS} optionType="button" buttonStyle="solid" />
          <Button icon={<ReloadOutlined />} onClick={() => { resetDemo.mutate(); setRows([]); setOutcome(null); message.success('演示数据已重置') }}>重置演示</Button>
        </Space>
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="批量复测规则"
        description="① 同根因回归不另开问题，在原问题上新开结论周期；② 提交前一起校验修订号/版本/证据，有一条变化整批不写入并列出冲突；③ 写入失败按原批次重试，幂等不重复追加；④ 他人先领取的条目，你的提交只留存草稿。"
      />

      <div className="review-grid" style={{ gridTemplateColumns: 'minmax(0, 1.35fr) minmax(380px, 1fr)' }}>
        <div className="panel">
          <div className="panel-head"><h3>复测队列</h3><Space><Tag color="orange">{queue.length} 项待复测</Tag><Tag color="red">{queue.filter((item) => chainState(item) === '回归').length} 项回归</Tag></Space></div>
          <Table
            rowKey="key"
            columns={columns}
            dataSource={queue}
            pagination={false}
            rowClassName={(record) => (record.key === activeKey ? 'ant-table-row-selected' : '')}
            onRow={(record) => ({ onClick: () => setActiveKey(record.key) })}
            scroll={{ x: 720 }}
          />
        </div>

        <div className="panel review-box" style={{ maxHeight: 720, overflowY: 'auto' }}>
          {active ? (
            <>
              <Typography.Title level={4}>{active.key}</Typography.Title>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="问题">{active.title}</Descriptions.Item>
                <Descriptions.Item label="根因">{active.rootCause}</Descriptions.Item>
                <Descriptions.Item label="修复说明">{active.fixNote ?? '未提交'}</Descriptions.Item>
                <Descriptions.Item label="复测环境">{active.retestEnv ?? '待开发提交'}</Descriptions.Item>
              </Descriptions>

              <Typography.Title level={5} style={{ marginTop: 18 }}>结论链（问题 → 复测 → 版本差异）</Typography.Title>
              <Timeline
                items={active.chain.map((cycle) => ({
                  color: cycleColor(cycle),
                  children: (
                    <div>
                      <Space size={6} wrap>
                        <Typography.Text strong>周期 #{cycle.index + 1}</Typography.Text>
                        <Tag>{cycle.openReason}</Tag>
                        {cycle.verdict ? <Tag color={verdictColor[cycle.verdict]}>{cycle.verdict} · {cycle.conclusionVersion}</Tag> : <Tag color="gold">待复测</Tag>}
                        {!cycle.valid && <Tag color="volcano">已失效：{cycle.invalidReason} · {cycle.invalidatedAt}</Tag>}
                      </Space>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {cycle.openedAt} 由 {cycle.openedBy} 打开（rev {cycle.openedRevision}）
                        {cycle.concludedAt && <> · {cycle.concludedAt} 由 {cycle.concludedBy} 结论</>}
                      </div>
                      {cycle.verdict === '退回' && cycle.index > 0 && <Typography.Text type="danger" style={{ fontSize: 12 }}>同一根因回归，沿用原问题，此前通过记录全部保留。</Typography.Text>}
                    </div>
                  ),
                }))}
              />

              {(() => {
                const records = active.retestRecords.filter((record) => record.cycleIndex === active.chain[active.chain.length - 1]?.index)
                return (
                  <>
                    <Typography.Title level={5}>当前周期复测记录</Typography.Title>
                    {records.length === 0 && <Typography.Text type="secondary">暂无记录</Typography.Text>}
                    {records.map((record) => (
                      <div className="timeline-item" key={record.id}>
                        <Tag color={verdictColor[record.result]}>{record.result}</Tag>
                        <Typography.Text strong>{record.actor}</Typography.Text>
                        <div>{record.note}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.at} · {record.environment} · {record.testVersion} · 批次 {record.batchId ?? '—'}</Typography.Text>
                      </div>
                    ))}
                  </>
                )
              })()}
            </>
          ) : (
            <Empty description="点击左侧问题查看结论链" />
          )}
        </div>
      </div>

      {rows.length > 0 && (
        <div className="panel" style={{ marginTop: 14, padding: 16 }}>
          <div className="panel-head" style={{ padding: '0 0 12px' }}>
            <h3>本批复测（{rows.length} 条）</h3>
            <Space>
              <Badge status={conflicts.size === 0 ? 'success' : 'error'} text={conflicts.size === 0 ? '依据校验全部一致' : `${conflicts.size} 条依据已变化`} />
              <Button size="small" danger icon={<ThunderboltOutlined />} onClick={() => runtimeActions.mutate({ faultArmed: true })}>模拟下批写入故障</Button>
            </Space>
          </div>
          <Space wrap style={{ marginBottom: 12 }}>
            <span className="muted">复测环境</span>
            <Input value={environment} onChange={(event) => setEnvironment(event.target.value)} style={{ width: 260 }} placeholder="浏览器 / 辅助技术" />
            <span className="muted">候选版本</span>
            <Input value={testVersion} onChange={(event) => setTestVersion(event.target.value)} style={{ width: 130 }} placeholder="v4.19" />
          </Space>
          <Table
            rowKey="key"
            pagination={false}
            dataSource={rows.map((row) => ({ ...row, issue: issues.find((item) => item.key === row.key)! })).filter((row) => row.issue)}
            columns={[
              { title: '问题', width: 220, render: (_, record) => <div><Typography.Text strong>{record.key}</Typography.Text><div className="muted">{record.issue.title}</div></div> },
              { title: '结论', width: 210, render: (_, record) => <Radio.Group value={record.verdict} onChange={(event) => patchRow(record.key, { verdict: event.target.value as RetestVerdict })} optionType="button" buttonStyle="solid" size="small" options={[{ value: '通过', label: '通过' }, { value: '退回', label: '退回（回归）' }, { value: '不适用', label: '不适用' }]} /> },
              {
                title: '依据 / 复测记录',
                render: (_, record) => (
                  <div>
                    <Space size={6} wrap style={{ marginBottom: 6 }}>
                      <Tag>rev {record.basisRevision}</Tag>
                      <Tag>{record.basisVersion}</Tag>
                      <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis title={record.evidenceFp}>{record.evidenceFp.split('/').pop()}</Typography.Text>
                      {(conflicts.get(record.key) ?? []).map((conflict) => <Tag key={conflict.code} color="red" icon={<ExclamationCircleOutlined />}>{conflict.message}</Tag>)}
                      {conflicts.has(record.key) && <Button size="small" type="link" onClick={() => refreshBasis(record.key)}>按当前记录刷新依据</Button>}
                    </Space>
                    <Input.TextArea rows={2} value={record.note} onChange={(event) => patchRow(record.key, { note: event.target.value })} placeholder="记录实际操作、结果与证据位置（必填）" />
                  </div>
                ),
              },
              { title: '', width: 70, render: (_, record) => <Button size="small" type="link" danger onClick={() => release(record.key)}>移出</Button> },
            ]}
          />
          {outcome?.kind === 'fault' && (
            <Alert
              style={{ marginTop: 12 }}
              type="error"
              showIcon
              message={`批次 ${outcome.batchId} 写入失败，未追加任何记录`}
              description="服务端在写入前发生故障。请使用同一批次重试，服务端按 batchId 幂等，成功后也不会重复追加记录。"
              action={<Button type="primary" danger loading={submitting} onClick={() => submit(outcome.batchId)} icon={<ReloadOutlined />}>按原批次重试</Button>}
            />
          )}
          {outcome?.kind === 'ok' && (
            <Alert
              style={{ marginTop: 12 }}
              type="success"
              showIcon
              message={outcome.idempotent ? `批次 ${outcome.batchId} 重试成功（幂等回放，未重复追加）` : `批次 ${outcome.batchId} 已写入 ${outcome.count} 条结论`}
            />
          )}
          <div style={{ textAlign: 'right', marginTop: 12 }}>
            <Button type="primary" size="large" loading={submitting} disabled={conflicts.size > 0} onClick={() => submit()}>
              校验依据并整批提交{conflicts.size > 0 ? `（${conflicts.size} 条待核对）` : ''}
            </Button>
          </div>
        </div>
      )}

      {outcome?.kind === 'conflicts' && (
        <Modal
          open
          title={`批次 ${outcome.data.batchId} 整批未写入 · 冲突清单`}
          onCancel={() => setOutcome(null)}
          onOk={() => setOutcome(null)}
          okText="我知道了"
        >
          <Alert type="warning" showIcon style={{ marginBottom: 12 }} message="有一条依据变化即整批不写入；以下条目均已按提交内容留存草稿，可在下方草稿箱取回。" />
          {outcome.data.conflicts.map((conflict, index) => (
            <div key={`${conflict.key}-${conflict.code}-${index}`} style={{ marginBottom: 8 }}>
              <Space align="start"><Tag color="red">{conflict.key}</Tag><div><Typography.Text strong>{conflict.message}</Typography.Text>{conflict.expected !== undefined && <div className="muted" style={{ fontSize: 11 }}>提交依据：{String(conflict.expected)} ｜ 当前记录：{String(conflict.actual)}</div>}</div></Space>
            </div>
          ))}
        </Modal>
      )}

      <div className="panel" style={{ marginTop: 14, padding: 16 }}>
        <div className="panel-head" style={{ padding: '0 0 12px' }}><h3>草稿箱</h3><Tag color="default">{drafts.length} 份（后到者 / 冲突留底）</Tag></div>
        {drafts.length === 0 ? (
          <Typography.Text type="secondary">暂无草稿。两人同时处理同一条时，先到者生效，后到者的提交会出现在这里。</Typography.Text>
        ) : (
          <Table
            rowKey="id"
            size="small"
            pagination={false}
            dataSource={drafts}
            columns={[
              { title: '问题', dataIndex: 'key', width: 110, render: (value) => <Typography.Text strong>{value}</Typography.Text> },
              { title: '复测员', dataIndex: 'actor', width: 90 },
              { title: '结论', dataIndex: 'verdict', width: 80, render: (value: string) => <Tag color={verdictColor[value]}>{value}</Tag> },
              { title: '留底原因', dataIndex: 'reason', render: (value: string) => <Typography.Text type="warning">{value}</Typography.Text> },
              { title: '依据', width: 200, render: (_, record) => <span className="muted" style={{ fontSize: 11 }}>rev {record.basisRevision} · {record.basisVersion}</span> },
              { title: '时间', dataIndex: 'createdAt', width: 110 },
              {
                title: '',
                width: 80,
                render: (_, record) => (
                  <Button size="small" type="link" danger onClick={async () => { await discardDraft.mutateAsync(record.id); message.success('草稿已删除') }}>
                    删除
                  </Button>
                ),
              },
            ]}
          />
        )}
      </div>
    </section>
  )
}
