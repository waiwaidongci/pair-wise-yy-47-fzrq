import type { ConclusionCycle, Issue, RetestRecord } from './types'

type HistoryEvent = Issue['history'][number]

const commonHistory = (title: string): HistoryEvent[] => [
  { at: '09-22 10:35', actor: '李予 / 审核员', action: '创建问题', detail: `录入 ${title}，并关联页面录屏。` },
  { at: '09-24 16:10', actor: '系统', action: '根因聚类', detail: '与同类问题合并，保留子问题追溯关系。' },
]

/**
 * 旧数据升级：没有结论链的历史记录补齐首版周期。
 * - 有复测记录：以最后一条记录作为周期结论，链与记录对齐；
 * - 无复测记录：补一个打开中的首周期；
 * - 已通过但无任何记录（更老的脏数据）：补一条“历史遗留通过”结论，标注为升级补齐。
 */
export function bootstrapChain(issue: Issue): { chain: ConclusionCycle[]; records: RetestRecord[]; revision: number } {
  const records = issue.retestRecords.map((record, index) => ({ ...record, atIso: record.atIso ?? `2026-09-2${8 - (index % 2)}T${record.at.slice(-5)}:00`, cycleIndex: record.cycleIndex ?? 0, basisRevision: record.basisRevision ?? 0, evidenceFp: record.evidenceFp ?? issue.evidence }))
  const last = records[records.length - 1]
  const baseCycle: ConclusionCycle = {
    index: 0,
    openedAt: '09-22 10:35',
    openedBy: '系统（旧数据升级）',
    openReason: '首次复测',
    openedVersion: issue.version,
    openedRevision: 0,
    valid: true,
  }
  let chain: ConclusionCycle[]
  if (last) {
    chain = [{
      ...baseCycle,
      verdict: last.result,
      concludedAt: last.at,
      concludedBy: last.actor,
      conclusionVersion: last.testVersion ?? issue.version,
    }]
  } else if (issue.status === '已通过') {
    chain = [{ ...baseCycle, verdict: '通过', concludedAt: '历史', concludedBy: '系统（旧数据升级）', conclusionVersion: issue.version }]
  } else {
    chain = [baseCycle]
  }
  return { chain, records, revision: records.length }
}

export const seedIssues: Issue[] = [
  {
    key: 'A11Y-1048',
    title: '商品筛选抽屉无法通过键盘关闭',
    site: '商城 Web',
    version: 'v4.18',
    wcag: ['2.1.2 无键盘陷阱', '2.1.1 键盘'],
    issueType: '键盘操作',
    impact: '致命',
    affected: '筛选面板 / 移动端与桌面键盘用户',
    reproduction: '打开商品筛选抽屉，使用 Tab 遍历后按 Esc，焦点仍循环在抽屉内部。',
    evidence: 'https://evidence.example.com/a11y-1048',
    rootCause: '共用 Drawer 组件缺少 focus trap 退出逻辑',
    status: '修复中',
    priority: 'P0',
    team: '前端基础组件组',
    owner: '何沐',
    dueDate: '2026-10-06',
    mergedKeys: ['A11Y-1052', 'A11Y-1061'],
    retestRecords: [],
    history: commonHistory('筛选抽屉键盘陷阱'),
    revision: 0,
    chain: [],
  },
  {
    key: 'A11Y-1052',
    title: '客服弹窗焦点无法返回触发按钮',
    site: '商城 Web',
    version: 'v4.19-rc1',
    wcag: ['2.4.3 焦点顺序'],
    issueType: '焦点管理',
    impact: '严重',
    affected: '客服入口 / 所有键盘用户',
    reproduction: '打开客服弹窗，关闭后焦点落到 body。',
    evidence: 'https://evidence.example.com/a11y-1052',
    rootCause: '共用 Drawer 组件缺少 focus trap 退出逻辑',
    status: '已退回',
    priority: 'P1',
    team: '前端基础组件组',
    owner: '何沐',
    dueDate: '2026-10-03',
    mergedKeys: [],
    fixNote: 'v4.19 升级 Drawer 依赖时回归，恢复 triggerRef.focus 并补充回归用例。',
    retestEnv: 'Chrome 141 / VoiceOver / 商城 v4.19-rc1',
    retestRecords: [
      { id: 'RT-22', actor: '苏禾', result: '通过', note: '焦点返回触发按钮，顺序正确。', at: '09-28 14:20', atIso: '2026-09-28T14:20:00', environment: 'Chrome 140 / VoiceOver / 商城 v4.18.3', testVersion: 'v4.18.3', basisRevision: 0, evidenceFp: 'https://evidence.example.com/a11y-1052', cycleIndex: 0 },
      // 同一根因在 v4.19 回归：沿用原问题，原通过记录保留，新开周期
      { id: 'RT-40', actor: '苏禾', result: '退回', note: 'v4.19-rc1 客服弹窗关闭后焦点再次落到 body，同一 focus trap 根因回归。', at: '10-02 09:40', atIso: '2026-10-02T09:40:00', environment: 'Chrome 141 / VoiceOver / 商城 v4.19-rc1', testVersion: 'v4.19-rc1', basisRevision: 1, evidenceFp: 'https://evidence.example.com/a11y-1052', cycleIndex: 1 },
    ],
    history: [
      ...commonHistory('客服弹窗焦点恢复'),
      { at: '09-28 14:20', actor: '苏禾 / 复测员', action: '复测通过', detail: '周期 #1 通过，结论版本 v4.18.3。' },
      { at: '10-02 09:40', actor: '系统', action: '回归重开', detail: 'v4.19-rc1 检出同一根因回归，沿用 A11Y-1052，周期 #1 通过记录保留，新开周期 #2。' },
    ],
    revision: 2,
    chain: [
      { index: 0, openedAt: '09-22 10:35', openedBy: '系统（旧数据升级）', openReason: '首次复测', openedVersion: 'v4.18', openedRevision: 0, verdict: '通过', concludedAt: '09-28 14:20', concludedBy: '苏禾', conclusionVersion: 'v4.18.3', valid: true },
      { index: 1, openedAt: '10-02 09:30', openedBy: '系统', openReason: '回归重开', openedVersion: 'v4.19-rc1', openedRevision: 1, regressionFrom: 0, valid: true },
    ],
  },
  {
    key: 'A11Y-1061',
    title: '优惠券选择层存在键盘循环',
    site: '会员中心',
    version: 'v3.9',
    wcag: ['2.1.2 无键盘陷阱'],
    issueType: '键盘操作',
    impact: '严重',
    affected: '结算券选择 / 键盘用户',
    reproduction: 'Shift+Tab 超过首元素后焦点进入不可见元素。',
    evidence: 'https://evidence.example.com/a11y-1061',
    rootCause: '共用 Drawer 组件缺少 focus trap 退出逻辑',
    status: '待分配',
    priority: 'P1',
    team: '结算体验组',
    owner: '待分配',
    dueDate: '2026-10-10',
    mergedKeys: [],
    retestRecords: [],
    history: commonHistory('优惠券选择层键盘循环'),
    revision: 0,
    chain: [],
  },
  {
    key: 'A11Y-1074',
    title: '数据图表颜色对比度不足',
    site: '运营后台',
    version: 'v2.7',
    wcag: ['1.4.11 非文本对比度', '1.4.3 对比度'],
    issueType: '视觉对比',
    impact: '中等',
    affected: '经营趋势图 / 低视力用户',
    reproduction: '趋势线 3 与背景对比度约 2.6:1。',
    evidence: 'https://evidence.example.com/a11y-1074',
    rootCause: '图表主题色板未执行无障碍校验',
    status: '待复测',
    priority: 'P2',
    team: '数据可视化组',
    owner: '赵屿',
    dueDate: '2026-10-09',
    mergedKeys: [],
    fixNote: '更换色板并增加虚线纹理和可切换数据表。',
    retestEnv: 'Safari 26 / 对比度工具 / admin-v2.7.5',
    retestRecords: [],
    history: commonHistory('图表颜色对比度'),
    revision: 0,
    chain: [],
  },
  {
    key: 'A11Y-1083',
    title: '表单错误提示未被读屏软件播报',
    site: '采购门户',
    version: 'v1.12',
    wcag: ['3.3.1 错误识别', '4.1.3 状态消息'],
    issueType: '错误提示',
    impact: '严重',
    affected: '供应商注册表单 / 屏幕阅读器用户',
    reproduction: '填写无效税号并提交，视觉提示出现但无 live region。',
    evidence: 'https://evidence.example.com/a11y-1083',
    rootCause: '表单错误组件未接入 aria-live 和字段描述',
    status: '已退回',
    priority: 'P1',
    team: '供应链前端组',
    owner: '顾雪',
    dueDate: '2026-10-05',
    mergedKeys: [],
    fixNote: '计划仅增加视觉错误颜色。',
    retestRecords: [{ id: 'RT-31', actor: '李予', result: '退回', note: '仍需接入 aria-live，并验证字段 aria-describedby。', at: '09-28 11:05' }],
    history: commonHistory('表单错误提示'),
    revision: 0,
    chain: [],
  },
  {
    key: 'A11Y-1090',
    title: '跳转链接（Skip Link）缺失',
    site: '采购门户',
    version: 'v1.12',
    wcag: ['2.4.1 跳过区块'],
    issueType: '键盘导航',
    impact: '中等',
    affected: '全站页头 / 键盘用户',
    reproduction: 'Tab 进入页面时无法跳过主导航直达主内容。',
    evidence: 'https://evidence.example.com/a11y-1090',
    rootCause: '布局模板未输出 skip link 锚点',
    status: '已通过',
    priority: 'P2',
    team: '供应链前端组',
    owner: '顾雪',
    dueDate: '2026-09-30',
    mergedKeys: [],
    fixNote: '页首增加指向主内容的跳过链接，并加入视觉焦点样式。',
    retestEnv: 'Chrome 140 / JAWS / portal-v1.12.1',
    retestRecords: [
      { id: 'RT-35', actor: '周野', result: '通过', note: '首个 Tab 即出现“跳到主内容”，焦点正确，播报正常。', at: '09-29 16:05', atIso: '2026-09-29T16:05:00', environment: 'Chrome 140 / JAWS / portal-v1.12.1', testVersion: 'v1.12.1', basisRevision: 0, evidenceFp: 'https://evidence.example.com/a11y-1090', cycleIndex: 0 },
    ],
    history: [
      ...commonHistory('跳转链接缺失'),
      { at: '09-29 16:05', actor: '周野 / 复测员', action: '复测通过', detail: '周期 #1 通过，结论版本 v1.12.1。' },
    ],
    revision: 1,
    chain: [
      { index: 0, openedAt: '09-22 10:35', openedBy: '系统（旧数据升级）', openReason: '首次复测', openedVersion: 'v1.12', openedRevision: 0, verdict: '通过', concludedAt: '09-29 16:05', concludedBy: '周野', conclusionVersion: 'v1.12.1', valid: true },
    ],
  },
]
