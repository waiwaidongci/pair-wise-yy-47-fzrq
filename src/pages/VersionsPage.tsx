import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { HistoryOutlined, RollbackOutlined, UploadOutlined, WarningOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import type { ConclusionCycle, Issue } from '../api/types'
import { chainState, chainSummary, compareVersions } from '../api/engine'
import { useDevSubmit, useResetDemo, useRuntime, useRuntimeActions } from '../api/hooks'

type DiffRow = {
  key: string
  issue: Issue
  current: ConclusionCycle | undefined
  baselineVerdict: string
  candidateVerdict: string
  status: '修复' | '回归' | '回归已复测' | '失效' | '保持通过' | '退回中'
  validConclusion: boolean
  chainText: string
}

const statusMeta = {
  修复: { color: 'green', text: '本版修复' },
  回归: { color: 'red', text: '回归（原问题重开）' },
  回归已复测: { color: 'cyan', text: '回归已复测通过' },
  失效: { color: 'volcano', text: '结论失效·按当前重算' },
  保持通过: { color: 'success', text: '保持通过' },
  退回中: { color: 'orange', text: '退回待修' },
}

export default function VersionsPage() {
  useIssues()
  const issues = useWorkspaceStore((state) => state.issues)
  const runtimeQuery = useRuntime()
  const runtimeActions = useRuntimeActions()
  const devSubmit = useDevSubmit()
  const resetDemo = useResetDemo()
  const [baselineVersion, setBaselineVersion] = useState('v4.18.3')
  const [candidateVersion, setCandidateVersion] = useState('v4.19-rc1')
  const [chainIssue, setChainIssue] = useState<Issue | null>(null)
  const [devOpen, setDevOpen] = useState(false)
  const [devKey, setDevKey] = useState<string>('')
  const [devForm] = Form.useForm()

  const runtime = runtimeQuery.data

  /**
   * 版本差异不再另开问题或静态声称“已修复”：
   * 每一行的修复 / 回归 / 失效结论都由结论链在当前版本口径下实时派生。
   */
  const diffs = useMemo<DiffRow[]>(() => {
    return issues
      .filter((issue) => issue.chain.length > 0)
      .map((issue) => {
        const current = issue.chain[issue.chain.length - 1]
        const invalidated = issue.chain.some((cycle) => !cycle.valid)
        const hadPass = issue.chain.slice(0, -1).some((cycle) => cycle.verdict === '通过')
        let status: DiffRow['status']
        if (invalidated && !current?.verdict) status = '失效'
        else if (current?.verdict === '通过') {
          if (current.openReason === '回归重开' || hadPass) status = '回归已复测'
          else {
            status = '修复'
            // 结论版本不高于基线版本时不算本版修复
            if (current.conclusionVersion && compareVersions(current.conclusionVersion, baselineVersion) <= 0) status = '保持通过'
          }
        } else if (current?.verdict === '退回') status = hadPass ? '回归' : '退回中'
        else status = hadPass ? '回归' : '退回中'

        const baselineCycle = [...issue.chain].reverse().find((cycle) => cycle.verdict && cycle.conclusionVersion && compareVersions(cycle.conclusionVersion, baselineVersion) <= 0)
        return {
          key: issue.key,
          issue,
          current,
          baselineVerdict: baselineCycle ? `${baselineCycle.verdict} ${baselineCycle.conclusionVersion}` : '未通过',
          candidateVerdict: current?.verdict ? `${current.verdict} ${current.conclusionVersion ?? issue.version}` : '待复测',
          status,
          validConclusion: current?.valid !== false,
          chainText: chainSummary(issue),
        }
      })
  }, [issues, baselineVersion])

  const fixed = diffs.filter((row) => row.status === '修复').length
  const regressed = diffs.filter((row) => row.status === '回归').length
  const invalid = diffs.filter((row) => row.status === '失效').length

  const columns: ColumnsType<DiffRow> = [
    {
      title: '问题',
      dataIndex: 'key',
      width: 240,
      render: (_, record) => (
        <div>
          <Typography.Text strong>{record.key}</Typography.Text>
          <div>{record.issue.title}</div>
          <Typography.Text type="secondary" style={{ fontSize: 11 }}>同根因：{record.issue.rootCause}</Typography.Text>
        </div>
      ),
    },
    {
      title: '差异结论',
      width: 190,
      render: (_, record) => {
        const meta = statusMeta[record.status]
        return (
          <Space direction="vertical" size={2}>
            <Tag color={meta.color} style={{ marginInlineEnd: 0 }}>{meta.text}</Tag>
            {record.status === '回归' && <Typography.Text type="danger" style={{ fontSize: 11 }}>沿用原问题，不另开一条</Typography.Text>}
            {record.status === '失效' && <Typography.Text type="warning" style={{ fontSize: 11 }}>旧结论保留但已失效</Typography.Text>}
          </Space>
        )
      },
    },
    { title: '基线口径', dataIndex: 'baselineVerdict', width: 150, render: (value) => <span style={{ color: '#9a4d35' }}>{value}</span> },
    { title: '候选版本口径', dataIndex: 'candidateVerdict', width: 160, render: (value) => <span style={{ color: '#26705a' }}>{value}</span> },
    {
      title: '结论链',
      dataIndex: 'chainText',
      render: (value: string, record) => (
        <Space size={6} wrap>
          <Typography.Text style={{ fontSize: 12 }}>{value}</Typography.Text>
          <Button size="small" type="link" icon={<HistoryOutlined />} onClick={() => setChainIssue(record.issue)}>查看</Button>
        </Space>
      ),
    },
    {
      title: '操作',
      width: 150,
      render: (_, record) => (
        <Button size="small" icon={<UploadOutlined />} onClick={() => { setDevKey(record.key); setDevOpen(true); devForm.setFieldsValue({ version: 'v4.19-rc2', fixNote: record.issue.fixNote ?? '', retestEnv: record.issue.retestEnv ?? '', actor: '何沐' }) }}>
          开发提交候选版
        </Button>
      ),
    },
  ]

  const expiredKeys = runtime?.expiredKeys ?? []

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">VERSION DIFF / 版本差异</p>
          <h1>结论链驱动的版本差异</h1>
          <p className="muted">差异结论实时派生自问题的结论链：回归沿用原问题；版本回退或证据过期时旧结论立即失效、按当前记录重算，不再把旧问题算作修复。</p>
        </div>
        <Space>
          <span>基线</span>
          <Select value={baselineVersion} onChange={setBaselineVersion} style={{ width: 130 }} options={['v4.18', 'v4.18.3'].map((value) => ({ value, label: value }))} />
          <span>候选</span>
          <Select value={candidateVersion} onChange={setCandidateVersion} style={{ width: 140 }} options={['v4.19-rc1', 'v4.19-rc2', 'v4.19'].map((value) => ({ value, label: value }))} />
          <Button icon={<RollbackOutlined />} danger onClick={() => runtimeActions.mutate({ rollbackVersion: 'v4.18.0' })}>模拟版本回退 v4.18.0</Button>
          <Button onClick={() => { runtimeActions.mutate({ rollbackVersion: null }); message.success('回退标记已解除（已失效结论不会自动复活，须重新复测）') }}>解除回退</Button>
          <Button onClick={() => { resetDemo.mutate(); message.success('演示数据已重置') }}>重置</Button>
        </Space>
      </div>

      {runtime?.rollbackVersion && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          message={`线上基线已回退至 ${runtime.rollbackVersion}：所有结论版本高于它的「通过 / 不适用」结论立即失效`}
          description="结论记录保留为「已失效」，问题进入失效重开周期，报告与本页差异立即按当前记录重算；重新通过后才会计入修复。"
        />
      )}

      <Space style={{ marginBottom: 12 }} wrap>
        <Tag color="green">本版修复 {fixed}</Tag>
        <Tag color="red">回归 {regressed}</Tag>
        <Tag color="volcano">结论失效 {invalid}</Tag>
        <span className="muted">标记证据过期以演示“证据过期 → 结论立即失效”：</span>
        <Select
          mode="multiple"
          allowClear
          style={{ minWidth: 280 }}
          placeholder="选择结论证据过期的问题"
          value={expiredKeys}
          onChange={(keys) => runtimeActions.mutate({ expiredKeys: keys })}
          options={issues
            .filter((issue) => issue.chain.some((cycle) => cycle.verdict === '通过'))
            .map((issue) => ({ value: issue.key, label: `${issue.key}（证据 ${issue.evidence.split('/').pop()}）` }))}
        />
      </Space>

      <div className="panel">
        <div className="panel-head"><h3>差异清单</h3><Tag color="blue">候选 {candidateVersion}</Tag></div>
        <Table rowKey="key" dataSource={diffs} columns={columns} pagination={false} scroll={{ x: 1180 }} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 14 }}>
        <div className="panel">
          <div className="panel-head"><h3>口径说明</h3><WarningOutlined style={{ color: '#ba8529' }} /></div>
          <div style={{ padding: 16, fontSize: 13 }}>
            <p>· <Typography.Text strong>回归</Typography.Text>：同一根因在新版本退回，差异页显示红色“回归”，链接回原问题；旧的通过周期和记录永久保留。</p>
            <p>· <Typography.Text strong>版本回退</Typography.Text>：通过结论版本高于当前基线时立即失效，不再算作已修复，重开周期等待复测。</p>
            <p>· <Typography.Text strong>证据过期</Typography.Text>：结论所依据的证据被标记过期后结论立即失效，按当前证据重测重算。</p>
          </div>
        </div>
        <div className="panel">
          <div className="panel-head"><h3>链上状态</h3></div>
          <div style={{ padding: 16 }}>
            {diffs.length === 0 && <Typography.Text type="secondary">暂无结论链</Typography.Text>}
            {diffs.slice(0, 5).map((row) => {
              const state = chainState(row.issue)
              const meta = { 回归: 'red', 结论失效: 'volcano', 已退回: 'orange', 已通过: 'green', 待复测: 'gold', 处理中: 'default' }[state]
              return (
                <div key={row.key} className="timeline-item">
                  <Space><Typography.Text strong>{row.key}</Typography.Text><Tag color={meta}>{state}</Tag></Space>
                  <div style={{ fontSize: 12 }}>{row.chainText}</div>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      <Modal
        title={chainIssue ? `${chainIssue.key} · 结论链` : ''}
        open={Boolean(chainIssue)}
        onCancel={() => setChainIssue(null)}
        footer={null}
        width={640}
      >
        {chainIssue && (
          <Timeline
            items={chainIssue.chain.map((cycle) => ({
              color: !cycle.valid ? 'red' : cycle.verdict === '通过' ? 'green' : cycle.verdict === '退回' ? 'red' : 'gray',
              children: (
                <div>
                  <Space wrap>
                    <Typography.Text strong>周期 #{cycle.index + 1}</Typography.Text>
                    <Tag>{cycle.openReason}</Tag>
                    {cycle.verdict ? <Tag color={cycle.verdict === '通过' ? 'success' : cycle.verdict === '退回' ? 'error' : 'default'}>{cycle.verdict} · {cycle.conclusionVersion}</Tag> : <Tag color="gold">待复测</Tag>}
                    {!cycle.valid && <Tag color="volcano">已失效：{cycle.invalidReason}</Tag>}
                  </Space>
                  <div className="muted" style={{ fontSize: 11 }}>{cycle.openedAt} 打开（{cycle.openedBy}）{cycle.concludedAt && ` · ${cycle.concludedAt} 结论（${cycle.concludedBy}）`}</div>
                  {cycle.regressionFrom !== undefined && <Typography.Text type="danger" style={{ fontSize: 12 }}>回归自周期 #{cycle.regressionFrom + 1}，原通过记录保留。</Typography.Text>}
                  {!cycle.valid && <Typography.Text type="warning" style={{ fontSize: 12 }}>失效时间 {cycle.invalidatedAt}，依据变化后按当前记录重算。</Typography.Text>}
                </div>
              ),
            }))}
          />
        )}
      </Modal>

      <Modal
        title={`${devKey} · 开发提交候选版本`}
        open={devOpen}
        onCancel={() => setDevOpen(false)}
        onOk={() => devForm.submit()}
        okText="提交复测"
      >
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message="提交会推进问题修订号（rev +1）。复测员已拍下的依据将立即显示 basis-changed，其整批提交被拦截，避免按旧依据结论。" />
        <Form
          form={devForm}
          layout="vertical"
          onFinish={async (values) => {
            await devSubmit.mutateAsync({ key: devKey, ...values })
            setDevOpen(false)
            message.success(`${devKey} 已提交候选版本 ${values.version}，原问题新开周期等待复测`)
          }}
        >
          <Form.Item name="actor" label="开发" rules={[{ required: true }]}><Input placeholder="开发姓名" /></Form.Item>
          <Form.Item name="version" label="候选版本" rules={[{ required: true }]}><Input placeholder="v4.19-rc2" /></Form.Item>
          <Form.Item name="fixNote" label="修复说明" rules={[{ required: true }]}><Input.TextArea rows={2} /></Form.Item>
          <Form.Item name="retestEnv" label="复测环境" rules={[{ required: true }]}><Input /></Form.Item>
        </Form>
      </Modal>

    </section>
  )
}
