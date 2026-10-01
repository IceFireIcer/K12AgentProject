/**
 * 会话标题 / 列表预览里的**机器标记**（2026-09-30 真机实测；判据 v2 同日放宽）。
 *
 * 这一组守的是一个**静默的视角泄漏**：从学习地图点「开始学习」时，界面替学生发出的是一条
 * 机器文本（首行形如「【学习计划】kp_id=…」），它成为会话的首条 user 消息；而 Pi 在会话
 * 还没有名字时会拿首条消息当标题 —— 列表上就印出了这串本来就只该发给模型的标记
 * （学生看到的是「【学习计划】kp_i…」）。
 *
 * ★★ 判据 v2 **只看形状、不看语义、不引入前缀白名单**：首行要满足「【X】」（标签 1~12 字），
 * 并且至少命中两条机器特征之一：
 *   ① 含 kp_id= / kpId=（学习计划、练习检验这类 wire）；
 *   ② 含一对角括号包起来的机器 id 形状「[A-Za-z0-9][A-Za-z0-9._-]{2,}」
 *      （编程求助那条真实首行：`我在做「prog-loop-jr」这道题`）。
 * 两条都不含 → 一个字不改。
 * ⚠️ 已知边界（显式断言，不假装不存在）：**学生原样引用我们的特征 token** 时会被当成标签
 *   （手打「【笔记】看 kp_id= 那段」）—— 判据认不出「谁写的」。代价有界：只改**列表标题
 *   这一行显示文本**，磁盘上的会话与发给模型的原文一个字节不动，最坏是外观级。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { SessionInfo } from '@earendil-works/pi-coding-agent'

import {
  projectSessionList,
  searchSessions,
  sessionTitleFrom,
  wireLabelOf
} from '../src/main/study/sessions.ts'

/** 造一个 `SessionInfo`（只填测试关心的字段）。 */
function info(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
  return {
    path: `C:/tmp/sessions/${overrides.id}.jsonl`,
    cwd: 'C:/tmp',
    created: new Date('2026-09-30T01:00:00Z'),
    modified: new Date('2026-09-30T02:00:00Z'),
    messageCount: 3,
    firstMessage: '第一个问题',
    allMessagesText: '第一个问题\n模型的回答',
    ...overrides
  } as SessionInfo
}

// ── wireLabelOf：只认机器标记 ─────────────────────────────────────────

test('wireLabelOf：三种机器首行都能还原（kp_id= 与角括号机器 id 两条特征）', () => {
  assert.equal(wireLabelOf('【学习计划】kp_id=prog-loop-jr\n知识点：循环结构'), '学习计划')
  assert.equal(wireLabelOf('【练习检验】kp_id=prog-loop-jr\n知识点：循环结构'), '练习检验')
  // cards/coding.ts 的真实首行：没有 kp_id=，靠角括号里的机器 id 命中
  assert.equal(
    wireLabelOf('【编程求助】我在做「prog-loop-jr」这道题，卡住了，请给我一点提示。'),
    '编程求助'
  )
  // 特征写成 kpId= 一样认（不同调用点的大小写写法都要能还原）
  assert.equal(wireLabelOf('【编程求助】kpId=prog-loop-jr 我在做这道题'), '编程求助')
})

test('wireLabelOf：学生自己打的【…】一个字都不动', () => {
  assert.equal(wireLabelOf('【重要】记得复习'), '')
  assert.equal(wireLabelOf('【学习计划】我想自己学'), '', '标签对但两条特征都没有 → 不改写')
  assert.equal(wireLabelOf('【练习检验】我自己出的题'), '')
})

test('wireLabelOf：角括号里必须是纯 ASCII 机器 id（汉字 / 太短都不命中）', () => {
  assert.equal(wireLabelOf('【学习计划】看「循环结构」这一节'), '', '角括号里是汉字 → 不命中')
  assert.equal(wireLabelOf('【编程求助】我在做「ab」这道题'), '', '机器 id 至少 3 个 ASCII 字符')
})

test('wireLabelOf：判据窄（非首行 / 超长标签 / 缺特征 / 空串）', () => {
  assert.equal(wireLabelOf('你好\n【学习计划】kp_id=x'), '', '只看第一行')
  assert.equal(wireLabelOf('\n【学习计划】kp_id=x'), '')
  assert.equal(wireLabelOf(`【${'甲'.repeat(13)}】kp_id=x`), '', '标签超过 12 字不认')
  assert.equal(wireLabelOf(`【${'甲'.repeat(12)}】kp_id=x`), '甲'.repeat(12), '12 字仍在判据内')
  assert.equal(wireLabelOf('【学习计划】'), '')
  assert.equal(wireLabelOf(''), '')
  assert.equal(wireLabelOf('   '), '')
  assert.equal(wireLabelOf('【学习计划】kp_id=x\n第二行'), '学习计划', '只取第一行的标签')
})

test('wireLabelOf：已知边界 —— 学生原样引用我们的特征 token 时会被当成标签', () => {
  // 判据只认形状、认不出「谁写的」：学生手打 kp_id= 或角括号机器 id 时，
  // 他写的那一行与机器 wire 在形状上完全一样。这里把它**明确断言**下来，
  // 而不是假装不存在 —— 代价有界：只有列表标题这一段显示文本会被改成标签，
  // 磁盘上的会话与发给模型的原文一个字节都不动。
  assert.equal(wireLabelOf('【笔记】看 kp_id= 那段'), '笔记')
  assert.equal(wireLabelOf('【复习】「prog-loop-jr」是什么'), '复习')
})

// ── sessionTitleFrom：标题的唯一投影 ──────────────────────────────────

test('sessionTitleFrom：name 优先 → 退回首条消息（先过机器标记还原）→ 占位', () => {
  assert.equal(sessionTitleFrom('循环练习', '问题'), '循环练习')
  assert.equal(sessionTitleFrom('循环练习', '【学习计划】kp_id=x'), '循环练习', '有名字就不用首条消息')
  assert.equal(sessionTitleFrom('', '【学习计划】kp_id=x\n知识点：循环结构'), '学习计划')
  assert.equal(sessionTitleFrom(undefined, '第二个问题'), '第二个问题')
  assert.equal(sessionTitleFrom('   ', '【练习检验】kp_id=x'), '练习检验', '只有空白的名字视为没有名字')
  assert.equal(sessionTitleFrom('', ''), '（空会话）')
  assert.equal(sessionTitleFrom(undefined, '   '), '（空会话）')
})

test('sessionTitleFrom：仍然按字符截断（maxChars 可覆盖）', () => {
  assert.equal(sessionTitleFrom(undefined, '一二三四五', 3), '一二三…')
  assert.equal(Array.from(sessionTitleFrom(undefined, '学'.repeat(100))).length, 25)
})

// ── 落到列表投影上 ───────────────────────────────────────────────────

test('会话列表：机器首条消息不再原样印到标题与预览', () => {
  const list = projectSessionList([
    info({ id: 'plan', firstMessage: '【学习计划】kp_id=prog-loop-jr\n知识点：循环结构' }),
    info({ id: 'quiz', firstMessage: '【练习检验】kp_id=prog-loop-jr\n知识点：循环结构' }),
    info({ id: 'coding', firstMessage: '【编程求助】我在做「prog-loop-jr」这道题，卡住了，请给我一点提示。' }),
    info({ id: 'mine', firstMessage: '【重要】记得复习' }),
    info({ id: 'named', name: '循环练习', firstMessage: '【学习计划】kp_id=x' })
  ])
  const byId = new Map(list.map((item) => [item.id, item]))
  assert.equal(byId.get('plan')?.title, '学习计划')
  assert.equal(byId.get('plan')?.preview, '学习计划', '预览走同一条投影')
  assert.equal(byId.get('quiz')?.title, '练习检验')
  assert.equal(byId.get('coding')?.title, '编程求助')
  assert.equal(byId.get('mine')?.title, '【重要】记得复习', '学生自己打的字原样保留')
  assert.equal(byId.get('mine')?.preview, '【重要】记得复习')
  assert.equal(byId.get('named')?.title, '循环练习', 'name 仍然优先')
  for (const item of list) {
    assert.equal(item.title.includes('kp_id='), false, `标题里不该出现机器字段：${item.title}`)
    assert.equal(item.preview.includes('kp_id='), false)
  }
})

test('搜索命中：标题同样走投影（不印机器标记）', () => {
  const hits = searchSessions(
    [
      info({
        id: 'plan',
        firstMessage: '【学习计划】kp_id=x\n知识点：循环结构',
        allMessagesText: '循环结构\n我们开始吧'
      })
    ],
    '循环结构'
  )
  assert.equal(hits.length, 1)
  assert.equal(hits[0].title, '学习计划')
})
