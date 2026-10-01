/**
 * 知识图谱卡片降密度（W3 / D 级决策）的回归守卫：
 * `Dependency.vue` 里那三块「卡片里只有一半数据」的展示（`directionLabel` /
 * `edgeSectionTitle` / `insp__edges`）已经删掉，不许复活 —— 它们把检查器塞满，
 * 用户真机走查判定「过密」。这是删减类决策的**反向断言**（与仓内「删干净」先例一致）。
 *
 * ⚠️ 必须先剥注释：本仓注释刻意引用坏写法（文件里就有一段说明那三块原来是什么）。
 *
 * 跑法：node --test tests/dependency-density.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const read = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

/** 剥注释（手写状态机）：注释里的旧写法说明不算实现。 */
function stripComments(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
      continue
    }
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4)
      i = end < 0 ? source.length : end + 3
      continue
    }
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i)
      i = end < 0 ? source.length : end
      continue
    }
    out += source[i]
    i += 1
  }
  return out
}

test('★ 图谱检查器降密度：directionLabel / edgeSectionTitle / insp__edges 不得复活', () => {
  const code = stripComments(read('src/renderer/src/views/Dependency.vue'))
  assert.ok(code.length > 0, 'Dependency.vue 读不到内容（锚点腐烂）')
  for (const dead of ['directionLabel', 'edgeSectionTitle', 'insp__edges']) {
    assert.ok(
      !code.includes(dead),
      dead + ' 又回到了 Dependency.vue —— 降密度决策（D 级）被回退了：' +
        '那三块是「卡片里只有一半数据」的展示，塞满检查器正是用户走查要消除的形态'
    )
  }
})

test('★ 降密度没有误删检查器本身：关键锚点与主行动仍在', () => {
  const source = read('src/renderer/src/views/Dependency.vue')
  assert.match(source, /data-testid="dependency-inspector"/, '检查器容器要保留')
  assert.match(source, /data-testid="dependency-go-learn"/, '「开始学习」主行动要保留')
  assert.match(source, /focusedEdges/, '边的数据通路仍在（只是不再单列一块边清单）')
})
