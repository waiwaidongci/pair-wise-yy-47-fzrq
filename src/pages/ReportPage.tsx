import { useMemo, useState } from 'react'
import { Button, Checkbox, Select, Space, Tag, Typography, message } from 'antd'
import { DownloadOutlined, FilePdfOutlined } from '@ant-design/icons'
import { useIssues } from '../api/useIssues'
import { useWorkspaceStore } from '../store/useWorkspaceStore'
import { chainState, chainSummary } from '../api/engine'

export default function ReportPage() {
  useIssues()
  const issues = useWorkspaceStore((state) => state.issues)
  const [site, setSite] = useState('全部站点')
  const [includeEvidence, setIncludeEvidence] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(true)
  const visible = issues.filter((item) => site === '全部站点' || item.site === site)

  /** 报告口径：只有当前周期为「通过」且结论仍有效才计入已修复；回归 / 失效一律不算 */
  const effectivePass = useMemo(() => visible.filter((item) => chainState(item) === '已通过').length, [visible])
  const regressed = visible.filter((item) => chainState(item) === '回归').length
  const invalidated = visible.filter((item) => chainState(item) === '结论失效').length
  const hadInvalidHistory = visible.filter((item) => item.chain.some((cycle) => !cycle.valid)).length

  const exportCsv = () => {
    const rows = [
      ['编号', '站点', '版本', '问题', 'WCAG', '影响', '当前结论', '结论链', '团队', '负责人', '截止日期'],
      ...visible.map((issue) => [
        issue.key,
        issue.site,
        issue.version,
        issue.title,
        issue.wcag.join(' / '),
        issue.impact,
        chainState(issue),
        chainSummary(issue),
        issue.team,
        issue.owner,
        issue.dueDate,
      ]),
    ]
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n')
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `无障碍整改报告-${site}.csv`
    link.click()
    URL.revokeObjectURL(url)
    message.success('报告已导出（结论链口径）')
  }

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">REPORT / 整改报告</p>
          <h1>可追溯的站点整改报告</h1>
          <p className="muted">修复口径来自结论链当前有效结论：回归沿用原问题不算新单，版本回退或证据过期的旧结论立即失效、不再算作已修复。</p>
        </div>
        <Space>
          <Button icon={<DownloadOutlined />} onClick={exportCsv}>导出 CSV</Button>
          <Button type="primary" icon={<FilePdfOutlined />} onClick={() => window.print()}>打印 / PDF</Button>
        </Space>
      </div>

      <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
        <Space wrap>
          <span>报告范围</span>
          <Select value={site} onChange={setSite} style={{ width: 150 }} options={['全部站点', ...new Set(issues.map((item) => item.site))].map((value) => ({ value }))} />
          <Checkbox checked={includeEvidence} onChange={(event) => setIncludeEvidence(event.target.checked)}>包含证据链接</Checkbox>
          <Checkbox checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)}>包含操作历史</Checkbox>
        </Space>
      </div>

      <Space style={{ marginBottom: 14 }} wrap>
        <Tag color="green">当前有效通过 {effectivePass}</Tag>
        <Tag color="red">回归 {regressed}</Tag>
        <Tag color="volcano">结论失效待重测 {invalidated}</Tag>
        <Tag color="default">历史含失效结论 {hadInvalidHistory}（记录保留，不计修复）</Tag>
      </Space>

      <article className="panel report-sheet">
        <header style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '3px solid #173e4d', paddingBottom: 16 }}>
          <div><Typography.Text type="secondary">数字体验无障碍治理项目</Typography.Text><h2>网站无障碍整改报告</h2><Typography.Text>生成日期：2026-10-03 · WCAG 2.2 AA · 结论链口径</Typography.Text></div>
          <div style={{ textAlign: 'right' }}><Tag color="blue">{site}</Tag><div>问题 {visible.length} 项</div><div>有效通过 {effectivePass} 项</div><div>回归 {regressed} · 失效 {invalidated}</div></div>
        </header>
        <table>
          <thead><tr><th>编号</th><th>页面 / 范围</th><th>问题与 WCAG</th><th>影响</th><th>当前结论 / 结论链</th><th>责任 / 截止</th></tr></thead>
          <tbody>
            {visible.map((issue) => {
              const state = chainState(issue)
              const tone = state === '已通过' ? '#26705a' : state === '回归' ? '#b84f32' : state === '结论失效' ? '#a75d1f' : '#74818a'
              return (
                <tr key={issue.key}>
                  <td>{issue.key}</td>
                  <td>{issue.site}<br /><Typography.Text type="secondary">{issue.version}</Typography.Text></td>
                  <td>
                    <strong>{issue.title}</strong><br />
                    {issue.wcag.join(' / ')}
                    {includeEvidence && <><br /><Typography.Link href={issue.evidence}>查看证据</Typography.Link></>}
                  </td>
                  <td><Tag color={issue.impact === '致命' ? 'red' : issue.impact === '严重' ? 'volcano' : 'gold'}>{issue.impact}</Tag></td>
                  <td>
                    <Typography.Text style={{ color: tone }} strong>{state}</Typography.Text>
                    <div style={{ fontSize: 11, marginTop: 2 }}>{chainSummary(issue)}</div>
                    {issue.chain.some((cycle) => !cycle.valid) && <Tag color="volcano" style={{ marginTop: 4 }}>含已失效结论（保留）</Tag>}
                    <div className="muted" style={{ fontSize: 11 }}>{issue.team} / {issue.owner}</div>
                  </td>
                  <td>{issue.dueDate}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {includeHistory && (
          <div style={{ marginTop: 20 }}>
            <Typography.Title level={5}>结论链关键事件（回归 / 失效 / 复测）</Typography.Title>
            {visible
              .flatMap((issue) =>
                issue.history
                  .filter((event) => /回归|失效|复测通过|复测退回|开发提交复测/.test(event.action))
                  .slice(-3)
                  .map((event) => ({ issue, event })),
              )
              .map(({ issue, event }, index) => (
                <div className="timeline-item" key={`${issue.key}-${event.at}-${index}`}>
                  <strong>{issue.key} · {event.action}</strong>
                  <div>{event.detail}</div>
                  <span className="muted">{event.actor} · {event.at}</span>
                </div>
              ))}
          </div>
        )}
      </article>
    </section>
  )
}
