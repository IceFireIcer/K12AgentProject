/**
 * 首次进入的「先接模型」这一步（W7）的守卫：**拦，但给逃生口**。
 *
 * 场景：全新启动还没配 Key 时五问照常能答，但答完的 LLM 概括会降级 —— 所以要在发问之前
 * 把模型接上。三条不变量：
 *   · 这一步只在「首次进入 + 未配 Key」出现（已有账号 / 已配好的机器一步都不多）；
 *   · 主行动「配好了，开始学习」只有**真实探测通过且配置没被改过**才可点；
 *   · 次行动「稍后配置」是逃生口（演示机 / 断网 / 家长不在场），不受探测结论约束。
 * 另一条硬纪律：表单本体是**共享组件**（设置页与账号门同一份），不许抄第二份实现。
 *
 * 跑法：node --test tests/model-setup-gate.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const DESKTOP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const readRenderer = (relativePath: string): string =>
  readFileSync(join(DESKTOP_ROOT, 'src', 'renderer', 'src', ...relativePath.split('/')), 'utf8').replace(/\r\n/g, '\n')

/** 剥注释（手写状态机）：注释里的说明不算实现（本仓注释刻意引用字段名与旧写法）。 */
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

/** 紧接着某个签名之后的一段窗口。 */
function windowAfter(source: string, signature: string, size: number): string {
  const at = source.indexOf(signature)
  assert.ok(at > 0, '找不到签名：' + signature)
  return source.slice(at, at + size)
}

const GATE = readRenderer('views/AccountGate.vue')
const SETTINGS = readRenderer('views/Settings.vue')
const SETUP = readRenderer('components/ModelSetup.vue')
const GATE_CODE = stripComments(GATE)
const SETTINGS_CODE = stripComments(SETTINGS)

test('★ 这一步只在「首次进入 + 未配 Key」出现；通道缺失时不拦路', () => {
  assert.match(GATE_CODE, /const step = ref<'form' \| 'model'>\('form'\)/, '两步状态机：默认先是表单')
  const submit = windowAfter(GATE_CODE, 'async function submitCreate(', 1000)
  assert.match(submit, /await settings\.load\(\)/, '先读一次设置（判「配没配」的事实来源）')
  assert.match(submit, /!hasAccounts\.value/, '只在「首次进入」（还没有任何账号）才走这一步')
  assert.match(
    submit,
    /settings\.bridgeError === null &&[\s\S]{0,40}?\(!settings\.hasStoredKey \|\| settings\.probe\?\.ok === false\)/,
    '判据：设置通道可用 **且**（没存过 Key 或探测未通过）才进这一步'
  )
  assert.match(submit, /step\.value = 'model'/, '命中判据才切到接模型那一步')
  assert.match(submit, /await finishCreate\(\)/, '已配好的机器直接建号（一步都不多）')
  assert.equal(
    (GATE_CODE.match(/step\.value = 'model'/g) ?? []).length,
    1,
    '只允许这一个入口切到 model 步（已有账号再次打开时不重复要）'
  )
  assert.match(GATE, /<section v-if="step === 'model'"[\s\S]{0,160}?data-testid="account-gate-model"/, '这一步要有容器锚点')
})

test('★ 主行动只有「真探测通过 + 配置没改过」才可点', () => {
  assert.match(
    GATE_CODE,
    /settings\.probe\?\.ok === true && !settings\.dirty/,
    '判据必须同时要求探测通过且没改过配置（旧结论不给新配置背书）'
  )
  const at = GATE.indexOf('account-gate-model-start')
  assert.ok(at > 0, '主行动必须有锚点')
  const button = GATE.slice(Math.max(0, at - 300), at + 160)
  assert.match(button, /:disabled="!probeReady \|\| accounts\.busy"/, '探测通过前主行动不可点')
  assert.ok(button.includes('配好了，开始学习'), '主行动文案固定（用户裁决）')
})

test('★ 逃生口存在且不受探测结论约束（拦，但给逃生口）', () => {
  const at = GATE.indexOf('account-gate-model-skip')
  assert.ok(at > 0, '逃生口必须有锚点（演示机 / 断网 / 家长不在场靠它放行）')
  const button = GATE.slice(Math.max(0, at - 140), at + 180)
  assert.ok(button.includes('稍后配置'), '逃生口文案固定（用户裁决）')
  assert.match(button, /@click="finishCreate\(\)"/, '逃生口与主行动共用同一条建号路径（不是第二个实现）')
  assert.doesNotMatch(button, /probeReady/, '逃生口不得被探测结论挡住')
})

test('★ 设置页与账号门用的是同一个组件（不是两份实现）', () => {
  const importLine = /import ModelSetup from '\.\.\/components\/ModelSetup\.vue'/
  assert.match(GATE_CODE, importLine, '账号门必须 import 共享组件')
  assert.match(GATE_CODE, /<ModelSetup /, '账号门必须真的挂上它')
  assert.match(SETTINGS_CODE, importLine, '设置页必须 import 同一个组件')
  assert.match(SETTINGS_CODE, /<ModelSetup /, '设置页必须真的挂上它')
  assert.match(SETUP, /data-testid="model-setup"/, '共享组件要有自己的根锚点')

  // 字段锚点只能长在共享组件里 —— 两处各写一份就是两份实现（本仓前科）
  for (const testid of [
    'settings-llm-preset',
    'settings-llm-providerid',
    'settings-llm-baseurl',
    'settings-llm-modelid',
    'settings-fetch-models'
  ]) {
    assert.ok(SETUP.includes(testid), '字段锚点必须在共享组件里：' + testid)
    assert.ok(!GATE_CODE.includes(testid), '账号门不许自己再写一份字段：' + testid)
    assert.ok(!SETTINGS_CODE.includes(testid), '设置页不许自己再写一份字段：' + testid)
  }
})

test('★ 给学生的说明是学生话（讲清「为什么必须配」），不含运维词', () => {
  const note = windowAfter(GATE, 'data-testid="account-gate-model"', 900)
  assert.ok(note.includes('没有它，团团连你问的问题都答不了'), '要说清不配模型的后果（学生能懂的那种）')
  for (const bad of ['API Key', 'BaseURL', 'subagent', '契约', '模型通道']) {
    assert.ok(!note.includes(bad), '学生面说明不许出现「' + bad + '」')
  }
})
