/**
 * A9：**卡片全量恢复（含动画卡回看态）**的单测。
 *
 * 2026-09-30 用户裁决推翻了「历史消息不恢复卡片」：卡片随会话落盘、回看原样带回
 * （每个 kind 都收，含动画）。这一组补的就是那条链路上两个「错了会静默出事」的点：
 *
 *   1. **恢复层打标记，实时层不打**：restoredCards 给每张恢复出来的卡打 restored: true，
 *      动画卡据此决定「回看态不重播当时那一遍」；live 路径（payload 事件）绝不能带这个标记，
 *      否则新生成的动画会被当成回看态而拒绝播放。restored 是**可选字段**，
 *      既有消费方不该因为它缺席而改变行为。
 *   2. **回看态不挂 iframe、但必须给出路**：动画卡在回看态只渲染文字要点 +
 *      「重新生成这段动画」（emit('generate')），绝不把历史里那份**一次性凭据**塞回 iframe。
 *      源码级断言，因为 node --test 里没有 Vue 运行时（与 animation-extension.test.ts 同一种写法）。
 *
 * ⚠️ 刻意**不**动 mountIframe 那一行：它的字面写法由 animation-extension.test.ts ②
 *    与变异 60 钉着，这里重复钉会互相打架（改一处两处红）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import {
  applyChatEvent,
  emptyConversation,
  restoreConversation,
  startTurn
} from '../src/renderer/src/api/events.ts'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RENDERER_ROOT = join(DESKTOP_ROOT, 'src', 'renderer', 'src')

/**
 * 读一份渲染层源码，同时给出「剥注释后的代码」。
 *
 * ★ 剥注释不是洁癖：本文件与源码里都用自然语言记录了这段历史（「一次性 nonce 不许
 *   绑回 iframe」「resourceUrl 会跟着会话落盘」），注释里必然出现 resourceUrl / :src
 *   这些标识符 —— 扫整份源码会把**说明**当成**实现**。
 * ★ CRLF 归一成 LF：切片锚点在 CRLF 文本里会错位（本仓库在 Windows 工作区里踩过）。
 */
function readRendererSource(relativePath: string): { source: string; code: string } {
  const source = readFileSync(join(RENDERER_ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n')
  const code = source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  return { source, code }
}

/* ================================================================== *
 * ① 恢复层：卡片全量带回 + restored 标记
 * ================================================================== */

test('★ restoreConversation：animation 卡片随历史带回，每张卡都带 restored 标记', () => {
  const animationPayload = { concept: '排序', html: '<html></html>', fallbackText: '排序是…' }
  const state = restoreConversation(
    [
      { role: 'user', text: '给我看个动画', entryId: 'u1' },
      {
        role: 'assistant',
        text: '这是动画',
        entryId: 'a1',
        cards: [
          { kind: 'animation', payload: animationPayload },
          { kind: 'quiz', payload: { q: 1 } },
          { kind: 'nope', payload: { q: 2 } }
        ]
      }
    ],
    'junior'
  )

  assert.equal(state.turns.length, 1, 'user + assistant 必须配成一轮（不是各占一轮）')
  const turn = state.turns[0]
  assert.equal(turn.text, '这是动画')
  assert.equal(turn.userText, '给我看个动画')
  assert.deepEqual(
    turn.cards.map((card) => card.kind),
    ['animation', 'quiz'],
    '认得出的 kind 全部带回（含 animation），认不出的整条丢掉'
  )
  assert.deepEqual(
    turn.cards.map((card) => card.restored),
    [true, true],
    '每张恢复出来的卡都必须带 restored: true（动画卡据此走回看态，不重播旧凭据）'
  )
  assert.deepEqual(
    turn.cards.map((card) => card.tool),
    [null, null],
    '历史里没有记 Tool 名，恢复层的 tool 恒为 null'
  )
  assert.deepEqual(turn.cards[0].payload, animationPayload, '载荷必须原样带回，恢复层不许解释或改写它')
  assert.deepEqual(
    turn.cards.map((card) => card.id),
    ['restored-0#0', 'restored-0#1'],
    'id 用恢复前缀 + 轮次 + **入参位置**（丢掉的卡不影响后面那张的 id）'
  )
})

test('★ live 路径（非恢复）不带 restored 标记（回归：可选字段不改变既有消费方）', () => {
  const live = applyChatEvent(
    startTurn(emptyConversation(), 'turn-live-1', '给我看个动画'),
    { name: 'payload', data: { requestId: 'turn-live-1', kind: 'animation', payload: { concept: '排序' } } }
  )
  const card = live.turns[0].cards[0]
  assert.equal(card.kind, 'animation')
  assert.equal(card.restored, undefined, '本轮实时产出的卡片不许带 restored —— 带了动画卡会误入回看态')
  assert.equal('restored' in card, false, '实时路径的卡片对象里不该出现 restored 这个键')
  assert.equal(card.id, 'turn-live-1#0', '实时路径的 id 仍是 requestId#序号（与恢复前缀区分开）')
})

test('★ 卡片只挂在助手那条上：学生消息上的 cards 被忽略', () => {
  const paired = restoreConversation([
    { role: 'user', text: '问题', entryId: 'u1', cards: [{ kind: 'quiz', payload: { q: 1 } }] },
    { role: 'assistant', text: '回答', entryId: 'a1' }
  ])
  assert.equal(paired.turns.length, 1)
  assert.deepEqual(paired.turns[0].cards, [], '卡片是回答的一部分，挂在学生气泡上只会多出一张无所属的卡')

  // 开场引导（开头就是 assistant）单独一轮，卡片照常带回
  const opening = restoreConversation([
    {
      role: 'assistant',
      text: '开场引导',
      entryId: 'a0',
      cards: [{ kind: 'animation', payload: { concept: '循环' } }]
    }
  ])
  assert.equal(opening.turns.length, 1)
  assert.equal(opening.turns[0].userText, '', '开场引导那条没有学生问题')
  assert.equal(opening.turns[0].cards.length, 1)
  assert.equal(opening.turns[0].cards[0].restored, true)
})

/* ================================================================== *
 * ② 动画卡回看态：源码级判据
 * ================================================================== */

test('★ 回看态的动画卡不挂 iframe（挂载判据含「非回看」条件，且面板 iframe 受它管）', () => {
  const { source } = readRendererSource('cards/AnimationCard.vue')

  // ① 判据的源头就是恢复层打的 restored 标记
  assert.match(
    source,
    /const restoredSnapshot = computed<boolean>\(/,
    '必须有 restoredSnapshot 判据（回看态的唯一入口）'
  )
  assert.match(
    source,
    /props\.card\.restored === true/,
    '回看判据必须读恢复层打的 card.restored 标记（不能从载荷里猜）'
  )
  // ② 挂 iframe 的可见性判据里含「非回看」
  assert.match(
    source,
    /const stageVisible = computed<boolean>\([\s\S]{0,160}?!restoredSnapshot\.value/,
    'stageVisible 必须包含「不是回看态」这一半 —— 否则回看会把旧凭据重新交给沙箱'
  )
  // ③ 模板里的 iframe 受 stageVisible 管（用精确的边界写法，不碰 mountIframe 那一行）
  assert.match(
    source,
    /<div v-if="stageVisible" class="anim__stage">/,
    '舞台容器必须由 stageVisible 控制（它含非回看条件）'
  )
  assert.match(source, /data-testid="animation-frame"/, '舞台里仍是同一个 iframe 元素')
  // ④ 回看态在界面上自报身份（排障与探针可读）
  assert.match(source, /:data-restored="restoredSnapshot \? '1' : null"/, '回看态要有可观测标记')
})

test('★ 回看态给的是「重新生成」入口（新交互配新凭据），不是重播旧的那一份', () => {
  const { source } = readRendererSource('cards/AnimationCard.vue')
  const at = source.indexOf('data-testid="animation-restore-generate"')
  assert.ok(at > 0, '回看态必须有 data-testid="animation-restore-generate" 的出口按钮')
  const button = source.slice(at, at + 240)
  assert.match(
    button,
    /@click="emit\('generate'\)"/,
    '回看态按钮必须走既有的生成入口（emit(generate)）—— 现场做一份新的，而不是复用历史里那份凭据'
  )
  assert.match(source, /v-if="restoredSnapshot"/, '回看态出口只在回看态渲染')
})

test('★★ 红线：界面源码不许把一次性地址塞回 iframe（回看态尤其不行）', () => {
  const { code } = readRendererSource('cards/AnimationCard.vue')
  assert.doesNotMatch(
    code,
    /\bresourceUrl\b/,
    '动画卡不许引用一次性托管地址（nonce 单次消费；绑回 iframe 会把 403 JSON 摆到学生眼前）'
  )
  assert.doesNotMatch(
    code,
    /:src=/,
    'iframe 只许走 srcdoc 内联 HTML —— 出现 :src= 就等于把持久化地址交给浏览器取第二次'
  )
  // 正面：内联仍是唯一数据源（与上面两条互为对照，删掉 srcdoc 也会红）
  assert.match(code, /:srcdoc="view\.html"/, 'iframe 必须直接吃内联 HTML（回看态读的也是同一份载荷）')
})
