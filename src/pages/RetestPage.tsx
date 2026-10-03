import { useMemo, useState } from 'react'
import { Alert, Button, Descriptions, Form, Input, Radio, Space, Switch, Table, Tag, Typography, message } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import axios from 'axios'
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import type { BatchReviewItem, Conflict, Issue, RetestResult } from '../api/types'
import { evidenceHashOf } from '../api/conclusionChain'
import { expireEvidence, isConflict, reviewBatch, reviewIssue, simulateConcurrent } from '../api/reviewApi'
import ConclusionChainView from '../components/ConclusionChainView'

const normalizeResult = (value: string): RetestResult => {
  if (value === '已通过' || value === '通过') return '通过'
  if (value === '已退回' || value === '退回') return '退回'
  return '不适用'
}

type BatchFormValues = { result: '已通过' | '已退回' | '不适用'; environment: string; note: string; simulateFail: boolean }

export default function RetestPage() {
  const { refetch } = useIssues()
  const issues = useWorkspaceStore((state) => state.issues)
  const updateIssue = useWorkspaceStore((state) => state.updateIssue)
  const drafts = useWorkspaceStore((state) => state.drafts)
  const addDraft = useWorkspaceStore((state) => state.addDraft)
  const removeDraft = useWorkspaceStore((state) => state.removeDraft)

  const queue = useMemo(() => issues.filter((item) => ['待复测', '已退回'].includes(item.status)), [issues])
  const [active, setActive] = useState<Issue | null>(queue[0] ?? null)
  const current = issues.find((item) => item.key === active?.key) ?? active
  const [form] = Form.useForm()
  const [batchForm] = Form.useForm<BatchFormValues>()

  const [batchKeys, setBatchKeys] = useState<string[]>([])
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null)
  const [failedBatch, setFailedBatch] = useState<{ batchId: string; items: BatchReviewItem[]; simulateFail: boolean } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [batchSubmitting, setBatchSubmitting] = useState(false)

  const buildItems = (keys: string[], values: BatchFormValues): BatchReviewItem[] =>
    keys.map((key) => {
      const issue = issues.find((i) => i.key === key)!
      return {
        issueKey: key,
        result: normalizeResult(values.result),
        note: values.note,
        environment: values.environment,
        basedOnSeq: issue.versionSeq ?? 1,
        evidenceHash: evidenceHashOf(issue),
        basedOnVersion: issue.version,
      }
    })

  const handleConflicts = (list: Conflict[], items: BatchReviewItem[], batchId: string) => {
    setConflicts(list)
    list.forEach((c) => {
      const item = items.find((i) => i.issueKey === c.issueKey)
      if (!item) return
      addDraft({
        ...item,
        reason: c.field === 'versionSeq' ? '并发冲突' : '整批冲突',
        conflictDetail: c.message,
        batchId,
      })
    })
    message.warning(`整批未写入：${list.length} 条依据已变化，冲突项已保留为草稿`)
  }

  const submitBatch = async () => {
    if (!batchKeys.length) {
      message.warning('请先勾选要批量复测的问题')
      return
    }
    const values = batchForm.getFieldsValue()
    if (!values.environment?.trim() || !values.note?.trim()) {
      message.warning('请填写本次复测环境与复测记录')
      return
    }
    const items = buildItems(batchKeys, values)
    const batchId = `BATCH-${crypto.randomUUID()}`
    setBatchSubmitting(true)
    try {
      const res = await reviewBatch({ batchId, items, simulateFail: values.simulateFail })
      if (res.idempotent) message.info('该批次已提交过，按原结果返回，未重复追加记录')
      else message.success(`已写入 ${res.updated} 条复测记录`)
      await refetch()
      setBatchKeys([])
      batchForm.resetFields()
      setConflicts(null)
      setFailedBatch(null)
    } catch (err) {
      if (isConflict(err)) {
        handleConflicts(err.response.data.conflicts ?? [], items, batchId)
      } else if (axios.isAxiosError(err) && err.response?.status === 500) {
        setFailedBatch({ batchId, items, simulateFail: !!values.simulateFail })
        message.error('写入失败：未追加任何记录，可按原批次重试')
      } else {
        message.error('写入失败，请重试')
      }
    } finally {
      setBatchSubmitting(false)
    }
  }

  const retryBatch = async () => {
    if (!failedBatch) return
    setBatchSubmitting(true)
    try {
      const res = await reviewBatch({ batchId: failedBatch.batchId, items: failedBatch.items, simulateFail: failedBatch.simulateFail })
      message.success(`已写入 ${res.updated} 条复测记录（按原批次重试，未重复追加）`)
      await refetch()
      setFailedBatch(null)
      setBatchKeys([])
    } catch (err) {
      if (isConflict(err)) handleConflicts(err.response.data.conflicts ?? [], failedBatch.items, failedBatch.batchId)
      else message.error('写入仍失败，请按原批次重试')
    } finally {
      setBatchSubmitting(false)
    }
  }

  const submitSingle = async (values: { result: '已通过' | '已退回' | '不适用'; note: string; environment: string }) => {
    if (!current) return
    setSubmitting(true)
    try {
      const idempotencyKey = `RT-${current.key}-${crypto.randomUUID()}`
      const data = await reviewIssue(current.key, {
        result: values.result,
        note: values.note,
        environment: values.environment,
        basedOnSeq: current.versionSeq ?? 1,
        evidenceHash: evidenceHashOf(current),
        basedOnVersion: current.version,
        idempotencyKey,
      })
      updateIssue(data)
      setActive(data)
      form.resetFields()
      message.success(`复测结果已记录：${values.result}`)
    } catch (err) {
      if (isConflict(err)) {
        const conflict = err.response.data.conflict
        addDraft({
          issueKey: current.key,
          result: normalizeResult(values.result),
          note: values.note,
          environment: values.environment,
          basedOnVersion: current.version,
          basedOnSeq: current.versionSeq ?? 1,
          evidenceHash: evidenceHashOf(current),
          reason: '并发冲突',
          conflictDetail: conflict?.message,
        })
        message.warning('该问题已被他人抢先处理，您的复测内容已保留为草稿')
      } else {
        message.error('写入失败，请重试')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const registerRegression = () => {
    if (!current) return
    form.setFieldsValue({
      result: '已退回',
      environment: current.retestEnv ?? '',
      note: `同根因回归：${current.rootCause}。问题在后续版本复现，沿用原问题 ${current.key}，原通过记录保留。`,
    })
  }

  const simulateOtherActor = async () => {
    if (!current) return
    const data = await simulateConcurrent(current.key)
    updateIssue(data)
    message.info(`已模拟另一位复测员抢先处理 ${current.key}，您的提交将冲突并保留草稿`)
  }

  const handleExpireEvidence = async () => {
    if (!current) return
    const data = await expireEvidence(current.key)
    updateIssue(data)
    message.warning('证据链接已变更，相关结论立即失效并按当前记录重算')
  }

  const continueDraft = (draft: (typeof drafts)[number]) => {
    const issue = issues.find((i) => i.key === draft.issueKey)
    if (issue) {
      setActive(issue)
      form.setFieldsValue({ result: draft.result === '通过' ? '已通过' : draft.result === '退回' ? '已退回' : '不适用', environment: draft.environment, note: draft.note })
    }
    removeDraft(draft.id)
    message.info('已载入草稿，提交前将重新校验依据')
  }

  const columns: ColumnsType<Issue> = [
    { title: '问题', dataIndex: 'key', render: (_, record) => <div><Typography.Text strong>{record.key}</Typography.Text><div>{record.title}</div></div> },
    { title: '修复说明', dataIndex: 'fixNote', width: 220, render: (value) => value ?? '未提交' },
    { title: '环境', dataIndex: 'retestEnv', width: 180, render: (value) => value ?? '待开发提交' },
    { title: '状态', dataIndex: 'status', width: 90, render: (value) => <Tag color={value === '已退回' ? 'error' : 'orange'}>{value}</Tag> },
  ]

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">RETEST / 复测工作台</p>
          <h1>逐项验证修复结果</h1>
          <p className="muted">复测必须记录环境和结论；退回的问题不可无痕跳过。批量提交前一起校验依据，整批原子写入。</p>
        </div>
        <Tag color="orange">{queue.length} 项待复测</Tag>
      </div>

      <Alert type="info" showIcon style={{ marginBottom: 12 }} message="复测规则" description="键盘问题必须覆盖 Tab、Shift+Tab、Esc 和焦点返回；屏幕阅读器问题需保留截图或播报日志。同根因回归沿用原问题，原通过记录保留；版本回退或证据过期时结论立即失效并按当前记录重算。" />

      {conflicts && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`整批未写入：${conflicts.length} 条依据已变化`}
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {conflicts.map((c) => (
                <li key={c.issueKey}><Typography.Text strong>{c.issueKey}</Typography.Text> · {c.message}</li>
              ))}
            </ul>
          }
        />
      )}

      {failedBatch && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message="上一批次写入失败，未追加任何记录"
          description={
            <Space>
              <span>批次 {failedBatch.batchId} · {failedBatch.items.length} 条，可按原批次重试（幂等，不重复追加）。</span>
              <Button size="small" type="primary" icon={<ReloadOutlined />} loading={batchSubmitting} onClick={retryBatch}>按原批次重试</Button>
            </Space>
          }
        />
      )}

      <div className="review-grid">
        <div className="panel">
          <div className="panel-head"><h3>复测队列</h3><span className="muted">勾选后可批量复测</span></div>
          <Table
            rowKey="key"
            columns={columns}
            dataSource={queue}
            pagination={false}
            rowSelection={{ selectedRowKeys: batchKeys, onChange: (keys) => setBatchKeys(keys as string[]) }}
            rowClassName={(record) => (record.key === current?.key ? 'ant-table-row-selected' : '')}
            onRow={(record) => ({ onClick: () => { setActive(record); form.resetFields() } })}
            scroll={{ x: 760 }}
          />
          <div style={{ borderTop: '1px solid #e7ecee', padding: 14 }}>
            <Typography.Title level={5}>批量复测（整批校验后写入）</Typography.Title>
            <Form form={batchForm} layout="vertical" initialValues={{ result: '已通过', simulateFail: false }}>
              <Form.Item name="result" label="批量结论" rules={[{ required: true }]}>
                <Radio.Group>
                  <Radio.Button value="已通过">通过</Radio.Button>
                  <Radio.Button value="已退回">退回</Radio.Button>
                  <Radio.Button value="不适用">不适用</Radio.Button>
                </Radio.Group>
              </Form.Item>
              <Form.Item name="environment" label="本次复测环境" rules={[{ required: true }]}><Input placeholder="浏览器 / 辅助技术 / 版本号" /></Form.Item>
              <Form.Item name="note" label="批量复测记录" rules={[{ required: true, message: '请填写可验证的复测记录' }]}><Input.TextArea rows={3} placeholder="记录实际操作、结果与证据位置" /></Form.Item>
              <Space style={{ width: '100%', justifyContent: 'space-between' }}>
                <Space>
                  <Switch checkedChildren="模拟写入失败" unCheckedChildren="正常写入" checked={batchForm.getFieldValue('simulateFail')} onChange={(v) => batchForm.setFieldValue('simulateFail', v)} />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>用于验证失败重试不重复追加</Typography.Text>
                </Space>
                <Button type="primary" loading={batchSubmitting} onClick={submitBatch} disabled={!batchKeys.length}>提交整批（{batchKeys.length} 条）</Button>
              </Space>
            </Form>
          </div>
        </div>

        <div className="panel review-box">
          <Typography.Title level={4}>{current?.key ?? '暂无可复测项'}</Typography.Title>
          {current && (
            <>
              <Descriptions size="small" column={1} bordered>
                <Descriptions.Item label="问题">{current.title}</Descriptions.Item>
                <Descriptions.Item label="根因">{current.rootCause}</Descriptions.Item>
                <Descriptions.Item label="修复说明">{current.fixNote ?? '未提交'}</Descriptions.Item>
                <Descriptions.Item label="复测环境">{current.retestEnv ?? '待开发提交'}</Descriptions.Item>
                <Descriptions.Item label="当前结论">
                  {(current.chain?.conclusions ?? []).filter((c) => c.status === '有效').map((c) => <Tag key={c.id} color="success">{c.result} · C{c.seq}</Tag>)}
                  {!(current.chain?.conclusions ?? []).some((c) => c.status === '有效') && <Tag>无有效结论，待复测</Tag>}
                </Descriptions.Item>
              </Descriptions>
              <Space style={{ marginTop: 10 }} wrap>
                <Button size="small" icon={<ThunderboltOutlined />} onClick={registerRegression}>登记回归（同根因沿用原问题）</Button>
                <Button size="small" onClick={simulateOtherActor}>模拟他人抢先处理</Button>
                <Button size="small" onClick={handleExpireEvidence}>模拟证据过期</Button>
              </Space>
              <Form form={form} layout="vertical" style={{ marginTop: 18 }} onFinish={submitSingle} initialValues={{ result: '已通过' }}>
                <Form.Item name="result" label="复测结论" rules={[{ required: true }]}>
                  <Radio.Group><Radio.Button value="已通过">通过</Radio.Button><Radio.Button value="已退回">退回</Radio.Button><Radio.Button value="不适用">不适用</Radio.Button></Radio.Group>
                </Form.Item>
                <Form.Item name="environment" label="本次复测环境" rules={[{ required: true }]}><Input placeholder="浏览器 / 辅助技术 / 版本号" /></Form.Item>
                <Form.Item name="note" label="复测记录" rules={[{ required: true, message: '请填写可验证的复测记录' }]}><Input.TextArea rows={4} placeholder="记录实际操作、结果与证据位置" /></Form.Item>
                <Button type="primary" htmlType="submit" block loading={submitting}>提交复测记录（先校验依据）</Button>
              </Form>
              <Typography.Title level={5} style={{ marginTop: 20 }}>结论链（可回溯）</Typography.Title>
              <ConclusionChainView conclusions={current.chain?.conclusions ?? []} />
              <Typography.Title level={5} style={{ marginTop: 16 }}>历史复测</Typography.Title>
              {current.retestRecords.length === 0 && <Typography.Text type="secondary">暂无历史记录</Typography.Text>}
              {current.retestRecords.map((record) => (
                <div className="timeline-item" key={record.id}>
                  <Tag color={record.result === '通过' ? 'success' : record.result === '退回' ? 'error' : 'default'}>{record.result}</Tag>
                  <Typography.Text strong>{record.actor}</Typography.Text>
                  <div>{record.note}</div>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>{record.at} · 依据 {record.basedOnVersion} · 证据 {record.evidenceHash}</Typography.Text>
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {drafts.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="panel-head"><h3>草稿箱（后到者留下的草稿）</h3><Tag>{drafts.length}</Tag></div>
          <div style={{ padding: 12 }}>
            {drafts.map((draft) => (
              <div key={draft.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid #edf1f2' }}>
                <Tag color="warning">{draft.reason}</Tag>
                <Typography.Text strong>{draft.issueKey}</Typography.Text>
                <Tag>{draft.result}</Tag>
                <Typography.Text type="secondary" style={{ flex: 1, fontSize: 12 }}>{draft.conflictDetail ?? draft.note}</Typography.Text>
                <Button size="small" onClick={() => continueDraft(draft)}>继续处理</Button>
                <Button size="small" type="text" danger onClick={() => removeDraft(draft.id)}>删除</Button>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
