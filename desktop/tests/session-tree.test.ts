/**
 * 会话树（分支关系的**展示**层）—— `architecture/pending/03` §3.6 的第三件事。
 *
 * ---------------------------------------------------------------------------
 * 这个功能要回答学生的三个问题
 * ---------------------------------------------------------------------------
 * 1. **这条是从哪条分出来的？** → `parentId` / `parentTitle`
 * 2. **它挂在谁下面？** → `depth` + `guides`（缩进与连接线）
 * 3. **这条下面还有多少？** → `childCount`（折叠箭头 + 「N 条分支」）
 *
 * 而这一层最容易出的两类错**都不会报错**：
 *   - **顺序错**：从旧会话分叉出来的新会话因为父文件 mtime 不变而沉在列表底部
 *     （学生刚聊过的找不到）；
 *   - **几何错**：连接线画错 → 看起来「挂在错误的父下面」，而数据其实是对的。
 *
 * ★ 本文件全部是**纯函数**测试（投影不碰文件系统），所以跑得飞快。
 *   真渲染的几何由 `npm run ux` 的 D 组盯着（它量真实 DOM）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const read = (rel: string): string => readFileSync(join(DESKTOP, rel), 'utf8')

const SESSION_LIST = 'src/renderer/src/components/SessionList.vue'

/** 造一个会话输入（只写关心的字段）。 */
function sess(
  id: string,
  modifiedAt: number,
  extra: { parentPath?: string; title?: string } = {}
): { id: string; title: string; messageCount: number; modifiedAt: number; parentPath?: string } {
  return {
    id,
    title: extra.title ?? id,
    messageCount: 1,
    modifiedAt,
    ...(extra.parentPath ? { parentPath: extra.parentPath } : {})
  }
}

const paths = (pairs: Array<[string, string]>): Map<string, string> => new Map(pairs)

/* ------------------------------------------------------------------ *
 * 1. 结构：扁平 + depth（界面按它缩进）
 * ------------------------------------------------------------------ */

test('★ 树是**深度优先展开**的扁平数组，`depth` 给出层级', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree(
    [
      sess('root', 100),
      sess('kid', 200, { parentPath: '/p/root' }),
      sess('grandkid', 300, { parentPath: '/p/kid' })
    ],
    paths([
      ['/p/root', 'root'],
      ['/p/kid', 'kid']
    ])
  )
  assert.deepEqual(
    tree.map((item) => [item.id, item.depth]),
    [
      ['root', 0],
      ['kid', 1],
      ['grandkid', 2]
    ],
    '★ 父在子**之前**（深度优先），层级 0/1/2'
  )
})

test('★ `childCount` 只数**直接**子（折叠箭头据此决定给不给）', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree(
    [
      sess('root', 100),
      sess('a', 200, { parentPath: '/p/root' }),
      sess('b', 300, { parentPath: '/p/root' }),
      sess('a1', 400, { parentPath: '/p/a' })
    ],
    paths([
      ['/p/root', 'root'],
      ['/p/a', 'a']
    ])
  )
  const of = (id: string) => tree.find((item) => item.id === id)?.childCount
  assert.equal(of('root'), 2, 'root 有两个直接子')
  assert.equal(of('a'), 1, '★ a 只有一个直接子（孙不算在 root 头上）')
  assert.equal(of('b'), 0, '叶子是 0 → 界面不给折叠箭头')
  assert.equal(of('a1'), 0)
})

test('★ `isLast` 与 `guides` 描述连接线几何（`└` vs `├`、竖线连到哪一层）', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  // root ├─ a ├─ a1
  //      │    └─ a2
  //      └─ b
  const tree = projectSessionTree(
    [
      sess('root', 100),
      sess('a', 500, { parentPath: '/p/root' }),
      sess('b', 400, { parentPath: '/p/root' }),
      sess('a1', 300, { parentPath: '/p/a' }),
      sess('a2', 200, { parentPath: '/p/a' })
    ],
    paths([
      ['/p/root', 'root'],
      ['/p/a', 'a']
    ])
  )
  const of = (id: string) => tree.find((item) => item.id === id)
  assert.deepEqual(of('root')?.guides, [], '根没有祖先 → 没有竖线')
  assert.equal(of('root')?.isLast, true, '只有一个根 → 它是最后一个')

  // a2 在 a 下面，而 a 在 root 下面且 a 后面还有 b（b 更新 → 排在 a 前？见下条断言）
  const a2 = of('a2')
  assert.equal(a2?.depth, 2)
  assert.equal(a2?.guides.length, 2, '★ 两层祖先 → 两段前导（长度必须 == depth）')
  assert.equal(a2?.isLast, true, 'a2 是 a 的最后一个子')
  // a2 的祖先链：深度 0 是 root（root 后面没有兄弟 → 不画竖线），
  //              深度 1 是 a（a 后面还有没有兄弟 → 由 a 的 isLast 决定）
  assert.equal(
    a2?.guides[1],
    !(of('a')?.isLast ?? true),
    '★ 深度 1 的竖线 = 「a 后面还有兄弟」——与 a 自己的 isLast 同源'
  )
})

test('★★ 几何不变量：`guides.length === depth`，且每段都是布尔', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree(
    [
      sess('r', 100),
      sess('a', 90, { parentPath: '/p/r' }),
      sess('b', 80, { parentPath: '/p/r' }),
      sess('a1', 70, { parentPath: '/p/a' }),
      sess('a2', 60, { parentPath: '/p/a' })
    ],
    paths([
      ['/p/r', 'r'],
      ['/p/a', 'a']
    ])
  )
  for (const item of tree) {
    assert.equal(
      item.guides.length,
      item.depth,
      `★ ${item.id}：前导段数必须等于层级（否则连接线会错位一格）`
    )
    assert.ok(
      item.guides.every((g) => typeof g === 'boolean'),
      `${item.id} 的 guides 必须是布尔（界面按它决定画不画线）`
    )
  }
})

/* ------------------------------------------------------------------ *
 * 2. ★★ 排序：家族活跃度（这条最容易错）
 * ------------------------------------------------------------------ */

test('★★ 从**旧**会话分叉出的新会话，把整个家族顶到列表前面', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  // root 很久以前建的（mtime=100）；但它的一条分支刚刚聊过（mtime=900）。
  // ★ 父文件的 mtime **不会**因为分叉而变 —— 只按各自的 modifiedAt 排根节点的话，
  //   这个家族会一直沉在底部，而学生**刚刚**才在里面聊过。
  const tree = projectSessionTree(
    [
      sess('old-root', 100),
      sess('old-branch', 900, { parentPath: '/p/old-root' }),
      sess('unrelated', 500)
    ],
    paths([['/p/old-root', 'old-root']])
  )
  assert.deepEqual(
    tree.map((item) => item.id),
    ['old-root', 'old-branch', 'unrelated'],
    '★ old-root 家族（最新活动 900）要排在 unrelated（500）之前'
  )
})

test('★★ 没有分支时顺序**退化**成「按修改时间倒序」（不是重新洗牌）', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree(
    [sess('a', 100), sess('b', 300), sess('c', 200)],
    new Map()
  )
  assert.deepEqual(
    tree.map((item) => item.id),
    ['b', 'c', 'a'],
    '★ 全是独立会话时，家族活跃度 == 自己的 mtime，顺序与改造前一致'
  )
})

test('★ 同层平局按 id 兜底（否则同毫秒的两条会每次刷新都跳）', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree([sess('zzz', 500), sess('aaa', 500)], new Map())
  assert.deepEqual(tree.map((item) => item.id), ['aaa', 'zzz'])
})

/* ------------------------------------------------------------------ *
 * 3. ★★ 坏数据：断环 + 自环（一个坏文件不该让整个列表打不开）
 * ------------------------------------------------------------------ */

test('★★ 环（A→B→A）被断开，**不栈溢出**', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  // 手改过的会话文件完全可能造出环；不断的话下面的深度优先遍历会无限递归。
  const tree = projectSessionTree(
    [
      sess('a', 100, { parentPath: '/p/b' }),
      sess('b', 200, { parentPath: '/p/a' })
    ],
    paths([
      ['/p/a', 'a'],
      ['/p/b', 'b']
    ])
  )
  assert.equal(tree.length, 2, '★ 两条都要出来（不是崩掉、也不是少一条）')
  // 断环之后至少有一条成为根（两者不能**都**声称有父，那正是环）
  const roots = tree.filter((item) => item.parentId === null)
  assert.ok(roots.length >= 1, '★ 环必须被断开（至少一条成为根）')
  for (const item of tree) {
    assert.ok(item.depth >= 0 && item.depth < 2, `${item.id} 的层级不该被环撑爆`)
  }
})

test('★ 自环（自己指向自己）当独立会话', async () => {
  const { projectSessionTree } = await import('../src/main/study/sessions.ts')
  const tree = projectSessionTree([sess('self', 100, { parentPath: '/p/self' })], paths([['/p/self', 'self']]))
  assert.equal(tree[0]?.parentId, null, '★ 自己当自己的父没有意义 → 当根')
  assert.equal(tree[0]?.depth, 0)
})

/* ------------------------------------------------------------------ *
 * 4. 兼容：没有树信息的响应要**平铺**，不是一堆 undefined
 * ------------------------------------------------------------------ */

test('★★ 侧栏把「缺树信息」归一化成平铺（不是 undefined）', () => {
  const source = read(SESSION_LIST)
  // ★ 判据是「归一化真的发生了」，而不是「源码里有 ?? 0」
  assert.match(
    source,
    /const items = computed<TreeRow\[\]>/,
    '★ 必须在 computed 里把可选字段归一化 —— 散在模板里漏一处就是渲染期 undefined'
  )
  for (const field of ['depth', 'childCount', 'isLast', 'guides']) {
    assert.match(
      source,
      new RegExp(`${field}:\\s`),
      `★ 归一化后的行必须**总是**给出 \`${field}\``
    )
  }
})

/* ------------------------------------------------------------------ *
 * 5. ★★ 界面：缩进、连接线、折叠
 * ------------------------------------------------------------------ */

test('★★ 缩进由 `depth` 驱动（不是写死的 padding）', () => {
  const source = read(SESSION_LIST)
  assert.match(source, /:data-depth="item\.depth"/, '★ 行上要带 data-depth（体检与排查都要量它）')
  assert.match(
    source,
    /v-for="\(hasMore, level\) in item\.guides"/,
    '★ 前导必须**逐层**渲染（每层一个 span）—— 画成一张背景图就做不到「按层判断有没有兄弟」'
  )
  assert.match(source, /session-tree-guide/, '前导要有稳定的 testid（体检脚本按它量）')
})

test('★★ 折叠箭头只给**有子分支**的节点，且与条目分属两个按钮', () => {
  const source = read(SESSION_LIST)
  const foldAt = source.indexOf('data-testid="session-fold"')
  assert.ok(foldAt > 0, '找不到折叠箭头')
  const before = source.slice(Math.max(0, foldAt - 300), foldAt)
  assert.match(
    before,
    /v-if="item\.childCount > 0"/,
    '★ 没有子分支就不该给箭头（点了没反应 = 学生以为坏了）'
  )
  // ★★ 箭头与条目是**两个**按钮：合成一个的话，想展开却切了会话（反之亦然）
  const itemAt = source.indexOf('data-testid="`session-item-${item.id}`"')
  assert.ok(itemAt > foldAt, '★ 折叠箭头必须在条目按钮**之外**（否则点击语义会混）')
  assert.match(
    source.slice(foldAt, itemAt),
    /@click\.stop="toggleCollapse/,
    '★ 折叠用 `.stop`：不让它冒泡到条目上（否则会顺带切一次会话）'
  )
})

test('★★ 收起一个节点 = 藏掉**整棵子树**（不是只藏直接子级）', () => {
  const source = read(SESSION_LIST)
  assert.match(
    source,
    /ancestorsOf\(item\.id\)\.some\(\(id\) => collapsed\.value\.has\(id\)\)/,
    '★ 判据必须是「任一祖先被收起」——只看直接父的话，收根之后孙辈还会露出来'
  )
  // 祖先链要有上限（坏数据的第二道防线；主进程那边已经断过环）
  assert.match(source, /guard < 64/, '★ 祖先链要有步数上限（防坏数据死循环）')
})

test('★ 窄栏（<1280）里树形前导折掉（60px 宽度下缩进只会挤掉文字）', () => {
  const source = read(SESSION_LIST)
  const narrow = source.slice(source.indexOf('@media (max-width: 1279px)'))
  assert.match(narrow, /\.sl__tree/, '★ 窄栏规则里要显式处理前导')
  assert.match(narrow, /\.sl__fold/, '★ 箭头也要一起折掉（同上）')
})
