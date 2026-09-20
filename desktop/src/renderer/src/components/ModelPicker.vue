<script setup lang="ts">
/**
 * 模型 / 供应商选择器（全局模态）。
 *
 * 这个界面此前**根本不存在** —— 模型只能靠学生自己去设置页手打一串 model id，
 * 而输入条上的模型 chip 是个不可点的 `<span>`。学生看到"deepseek-v4-flash"
 * 却没有任何办法换掉它。
 *
 * ── ★★ 两种视角（`viewMode.isTeacher`）：学生看状态，老师看配置 ──────────
 * 走查结论：把「探测可用性」与「去设置页自定义 BaseURL / Model ID」摆给一个 K12 学生，
 * 等于把一套专家配置界面塞进日常操作里 —— 他既不需要换端点，也读不懂那行提示。
 * 现在分两档：
 *   · **学生视角：只读**。打开就是「在用哪个模型 + 有哪些可选」，**列表项不可点**，
 *     也没有探测按钮与那条指向 BaseURL 的链接。
 *   · **教师 / 答辩视角**：完整三件事都回来 ——
 *       ① **选**：从候选清单里挑，选中即生效（输入条、顶栏、设置页同步）；
 *       ② **探测**：选完能当场验证可用性，给结论与时间，而不是"选完祈祷"；
 *       ③ **兜底**：想用目录里没有的，直接去设置页自填 —— 赛题要求"不写死供应商"。
 *
 * ⚠️ 学生的模型从哪来：**设置页那条保存链路**（`settings.save()` → `applyLlmConfig`
 *   → 写 `config.json` + 重写 Pi 的 `models.json`）。学生在学生视角下走
 *   设置 →「高级设置（教师 / 答辩）」→ 供应商（两次点击），弹层里那条
 *   `model-student-hint` 会把这条路指出来。
 *
 * ★★ 学生视角下**列表项不可点**是有意的 —— **别把点击加回去**：
 *   换模型实质是「换一个后端」，它连带 BaseURL / Key / 计费口径，
 *   是老师或家长的决定，不是学生日常要按的按钮。
 *   ⚠️ 既然如此，那两处 chip 的 `title` 也必须跟着改（`MessageComposer.vue` /
 *      `AppTopbar.vue` 各一处）：学生视角下不许再写「点这里更换」——
 *      那是在承诺一件做不到的事，学生点开只会看到一个点不动的清单
 *      （与「按钮文案指向下一个视图」那条纪律同类：界面不许撒谎）。
 *
 * ── 数据与动作全部来自 `stores/model.ts`（设置域的门面）──────────────────
 * 候选清单 = 当前供应商的候选（Pi 预设 ∪ 拉取结果），选中经 `select()` 写回
 * `config.json` 并重写 Pi 的 `models.json`；探测是**真实外呼**（`settings.probeNow()`）——
 * 原型里那个 900ms 的假探测连同写死的 4 项清单一起作废了：假探测比没有更坏，
 * 它会让「模型到底通不通」看起来已经被验证过了。
 *
 * ⚠️ `current` 为 `null`（设置还没读出来）时**不许编一个模型名**：头部如实写
 *   「正在读取设置…」，并顺手替学生把设置读一次（见下面的 `watch`）。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useEscape } from '../composables/useEscape'
import { useFocusReturn } from '../composables/useFocusReturn'
import {
  Check,
  Zap,
  Image as ImageIcon,
  Settings2,
  X,
  LoaderCircle,
  CircleCheck,
  CircleAlert
} from 'lucide-vue-next'
import { useModelStore } from '../stores/model'
import type { ModelOption } from '../stores/model'
import { useSettingsStore } from '../stores/settings'
import { useUiStore } from '../stores/ui'
import { useViewModeStore } from '../stores/viewMode'

const model = useModelStore()
const settings = useSettingsStore()
const ui = useUiStore()
const viewMode = useViewModeStore()

/**
 * 面板根元素。它是**模态**（全屏遮罩 + `aria-modal="true"`），所以焦点必须收束：
 * 打开移入、Tab 在层内循环、关闭还回触发它的模型 chip。
 * 开关状态在 store 里（本文件无权改 store）—— getter 直接读 store 的响应式值即可。
 */
const panelRef = ref<HTMLElement | null>(null)

const busy = computed(() => model.probePhase === 'probing')

/**
 * 打开弹层时若还没读过设置，就**当场读一次**。
 *
 * 为什么在这里发起：`model.current` 只是设置快照的投影，而快照只在学生进设置页时读
 * （`Settings.vue` 的 onMounted）—— 从顶栏点开选择器却不读，界面就永远只能显示
 * 「正在读取设置…」，那句「正在读取」也就成了假话。
 * ★ 仅在 `snapshot === null` 时触发：已有快照就不再读，免得把设置页里**没保存的草稿**冲掉。
 */
watch(
  () => model.pickerOpen,
  (open) => {
    if (open && settings.snapshot === null && !settings.loading) void settings.load()
  },
  { immediate: true }
)

/** 当前模型（还没读到时为 `null`）。 */
const active = computed<ModelOption | null>(() => model.current)

/** 头部那一行「当前用的是什么」：三种状态都如实说 */
const currentLine = computed(() => {
  if (active.value !== null) {
    return `当前：${active.value.providerName} · ${active.value.modelId}`
  }
  if (settings.loading) return '正在读取设置…'
  return settings.errorText ?? settings.bridgeError ?? '还没读到模型设置'
})

/** 清单为空时的一句实话（空列表不加解释看起来就像坏了） */
const emptyLine = computed(() => {
  if (settings.loading) return '正在读取设置…'
  if (model.catalog.length > 0) return ''
  // 「去设置页自填」这条指引只对教师 / 答辩视角成立：学生视角下那个入口不在界面上
  // （见文件头），所以这句话也要跟着换 —— 否则会把学生指到一个他看不到的地方。
  return viewMode.isTeacher
    ? '这一家供应商没有候选模型 —— 用下面的入口去设置页自填 BaseURL / Model ID。'
    : '这一家供应商没有可选模型。'
})

function isActive(option: ModelOption): boolean {
  const current = active.value
  return (
    current !== null &&
    current.providerId === option.providerId &&
    current.modelId === option.modelId
  )
}

/**
 * 列表项第二行：教师视角给「供应商 · BaseURL」，学生视角**只给供应商名**。
 *
 * ★ 为什么把 URL 也归到教师那一侧：它是排查用的端点地址，学生认不出
 *   `https://api.deepseek.com/v1` 和他有什么关系，而同一家供应商的多个模型
 *   靠「模型名 + 供应商名」已经分得开。端点本身没被藏起来 ——
 *   它在设置页的高级区里，一字不少。
 */
function optionMeta(option: ModelOption): string {
  if (option.providerName.length === 0) return viewMode.isTeacher ? option.baseUrl : ''
  return viewMode.isTeacher
    ? `${option.providerName} · ${option.baseUrl}`
    : option.providerName
}

/**
 * 选中即保存（`select()` 内部走设置域的保存链路并关掉弹层）。
 * ⚠️ 保存失败不会把弹层留在屏幕上（`select()` 自己关了），失败原因在
 *   `settings.errorText` 里，设置页会显示 —— 这里不另做一套失败提示。
 */
function choose(option: ModelOption): void {
  void model.select(option)
}

function goSettings(): void {
  model.closePicker()
  ui.go('settings')
}

/** 探测结论那一行：可用性 + 探测时刻（`latencyMs` 已随假探测一起作废） */
const probeLine = computed(() => {
  const result = model.probeResult
  if (result === null) return ''
  return `${result.ok ? '可用' : '不可用'}${result.at === null ? '' : ` · ${result.at}`}`
})

/**
 * 卸载时把弹层标记收回去：宿主（外壳）没了而 `pickerOpen` 还停在 true，
 * 下一次 `openPicker()` 就会开在一个不存在的弹层上（点了没反应）。
 */
onBeforeUnmount(() => model.closePicker())

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => model.closePicker(), () => model.pickerOpen)

/**
 * 焦点收束（契约第 8 节）：打开时把焦点移进面板、Tab 在层内循环、关闭还回触发元素。
 * 初焦点显式给「关闭」键而不是列表首项 —— 列表项点一下就**选中并关闭**，
 * 默认聚焦第一项会让「打开后手一抖按了回车」变成误选模型。
 */
useFocusReturn(panelRef, () => model.pickerOpen, {
  initial: () => panelRef.value?.querySelector<HTMLElement>('.mp__close') ?? null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="mp-fade">
      <div
        v-if="model.pickerOpen"
        ref="panelRef"
        class="mp"
        role="dialog"
        aria-modal="true"
        @click.self="model.closePicker()"
      >
        <div class="mp__box k12-float" data-testid="model-picker">
          <header class="mp__head">
            <div class="mp__head-text">
              <!-- 标题跟着形态走：学生那一份不能叫「选择模型」——
                   它是一个说明面板（点不了），写着「选择」而选不了就是一句谎话。 -->
              <p class="mp__title">{{ viewMode.isTeacher ? '选择模型' : '正在使用的模型' }}</p>
              <p class="mp__sub">{{ currentLine }}</p>
            </div>
            <button type="button" class="mp__close" title="关闭" @click="model.closePicker()">
              <X :size="16" />
            </button>
          </header>

          <!-- ★★ 候选清单分两种形态（同一份数据、同一批 testid）：
               · 教师 / 答辩视角 = **可选**的按钮列表（点一项即换，选中就保存）；
               · 学生视角 = **只读**的展示列表（哪一个是当前在用的，标出来就够了）。
                 ⚠️ 学生这一份刻意不做成「看起来能点、点了没反应」的按钮：
                    假按钮比没有按钮更坏 —— 学生会反复点它然后以为软件坏了。
                    它是 `<li>`（无 role、无指针态），读屏也不会把它念成可操作项。 -->
          <div v-if="viewMode.isTeacher" class="mp__list">
            <p v-if="emptyLine" class="mp__empty">{{ emptyLine }}</p>
            <button
              v-for="opt in model.catalog"
              :key="`${opt.providerId}/${opt.modelId}`"
              type="button"
              class="mp__item"
              :class="{ 'mp__item--on': isActive(opt) }"
              data-testid="model-option"
              :data-model="opt.modelId"
              :data-provider="opt.providerId"
              @click="choose(opt)"
            >
              <span class="mp__check">
                <Check v-if="isActive(opt)" :size="14" />
              </span>
              <span class="mp__item-text">
                <span class="mp__item-name">
                  {{ opt.modelId }}
                  <ImageIcon v-if="opt.vision" :size="12" class="mp__vision" title="支持图片输入" />
                </span>
                <span v-if="optionMeta(opt)" class="mp__item-meta">{{ optionMeta(opt) }}</span>
              </span>
              <span v-if="(opt.tags ?? []).length > 0" class="mp__tags">
                <span v-for="t in opt.tags ?? []" :key="t" class="mp__tag">{{ t }}</span>
              </span>
            </button>
          </div>

          <ul v-else class="mp__list mp__list--plain">
            <li v-if="emptyLine" class="mp__empty">{{ emptyLine }}</li>
            <li
              v-for="opt in model.catalog"
              :key="`${opt.providerId}/${opt.modelId}`"
              class="mp__item mp__item--static"
              :class="{ 'mp__item--on': isActive(opt) }"
              data-testid="model-option"
              :data-model="opt.modelId"
              :data-provider="opt.providerId"
              :data-active="String(isActive(opt))"
            >
              <span class="mp__check">
                <Check v-if="isActive(opt)" :size="14" />
              </span>
              <span class="mp__item-text">
                <span class="mp__item-name">
                  {{ opt.modelId }}
                  <ImageIcon v-if="opt.vision" :size="12" class="mp__vision" title="支持图片输入" />
                </span>
                <span v-if="optionMeta(opt)" class="mp__item-meta">{{ optionMeta(opt) }}</span>
              </span>
              <span v-if="isActive(opt)" class="mp__now">正在用</span>
            </li>
          </ul>

          <!-- 探测：选完当场验证。**真实外呼**（`settings.probeNow()`），
               结论与时刻都来自服务端回执，不是编的延迟。
               ★ 只在教师 / 答辩视角出现（见文件头）：学生视角下这一格整个不渲染 ——
                 探测是排障动作，学生点它得到的一段 HTTP 结论对他没有用处。 -->
          <div v-if="viewMode.isTeacher" class="mp__probe">
            <button
              type="button"
              class="mp__probe-btn"
              data-testid="model-probe"
              :disabled="busy"
              @click="model.probe()"
            >
              <component :is="busy ? LoaderCircle : Zap" :size="14" :class="{ mp__spin: busy }" />
              <span>{{ busy ? '探测中…' : '探测可用性' }}</span>
            </button>

            <div
              v-if="model.probeResult"
              class="mp__result"
              data-testid="model-probe-result"
              :data-ok="model.probeResult.ok"
            >
              <component
                :is="model.probeResult.ok ? CircleCheck : CircleAlert"
                :size="14"
                class="mp__result-ico"
              />
              <div class="mp__result-text">
                <p class="mp__result-line">{{ probeLine }}</p>
                <p class="mp__result-msg">{{ model.probeResult.message }}</p>
              </div>
            </div>
          </div>

          <!-- 学生视角的收尾：一句实话 + **去哪儿换**。
               它替代了教师视角那条「去设置页自定义 BaseURL / Model ID」——
               学生的模型从哪来见文件头：设置 → 高级设置（教师 / 答辩）里的「供应商」那一节，
               与老师的入口是同一份表单（`Model ID` 输入框 + 拉取模型清单 + 保存并生效）。 -->
          <footer v-else class="mp__foot">
            <p class="mp__hint" data-testid="model-student-hint">
              想在几个模型之间换，可以在「设置 → 高级设置（教师 / 答辩）→ 供应商」里改 Model ID。
            </p>
          </footer>

          <footer v-if="viewMode.isTeacher" class="mp__foot">
            <button
              type="button"
              class="mp__link"
              data-testid="model-settings-link"
              @click="goSettings"
            >
              <Settings2 :size="14" />
              <span>目录里没有我要的？去设置页自定义 BaseURL / Model ID</span>
            </button>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.mp {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: color-mix(in srgb, var(--k12-fg) 34%, transparent);
}
.mp__box {
  width: 100%;
  max-width: 560px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
}
.mp__head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 16px 18px;
  border-bottom: 1px solid var(--k12-border);
}
.mp__head-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.mp__sub {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.mp__close {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: var(--k12-r-inset);
  background: transparent;
  color: var(--k12-muted);
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__close:hover {
    background: var(--k12-surface-2);
    color: var(--k12-fg-2);
  }
}

.mp__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
/* 学生视角那一份是**只读**列表（`<ul>`）：去掉列表符号与内边距即可与上面同形 */
.mp__list--plain {
  margin: 0;
  list-style: none;
}
.mp__empty {
  padding: 16px 8px;
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
  text-align: center;
}
.mp__item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 11px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-card);
  background: var(--k12-surface);
  text-align: left;
  cursor: pointer;
}
/* 只读项：**不能**长得像能点的 —— 假按钮会让学生反复点然后以为软件坏了 */
.mp__item--static {
  cursor: default;
}
@media (hover: hover) and (pointer: fine) {
  .mp__item:not(.mp__item--static):hover {
    border-color: var(--k12-accent-border);
  }
}
/* 选中项：浅底 + 墨色描边。不用投影，靠底色与描边就够分得开。 */
.mp__item--on {
  background: var(--k12-accent-soft);
  border-color: var(--k12-accent);
}
/* 「正在用」：只读列表里那一项的状态字（学生要的是「现在用的是哪个」） */
.mp__now {
  flex: none;
  padding: 1px 8px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
  font-size: var(--k12-fs-xs);
  font-weight: 650;
  white-space: nowrap;
}
.mp__check {
  flex: none;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-accent-ink);
}
.mp__item--on .mp__check {
  background: var(--k12-accent-ink);
  color: var(--k12-surface);
}
.mp__item-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mp__item-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-sm);
  font-weight: 650;
  color: var(--k12-fg);
}
.mp__vision {
  color: var(--k12-muted);
}
/* 供应商 · BaseURL：这一项的说明性 meta（读得懂的键值），不是角标 */
.mp__item-meta {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp__tags {
  flex: none;
  display: flex;
  gap: 4px;
}
.mp__tag {
  padding: 1px 7px;
  border-radius: var(--k12-r-pill);
  background: var(--k12-surface-2);
  color: var(--k12-muted);
  font-size: var(--k12-fs-micro);
  font-weight: 600;
  white-space: nowrap;
}

.mp__probe {
  padding: 12px 18px;
  border-top: 1px solid var(--k12-border);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
/* 描边式按钮（形态参考 uiverse 社区的 outline 反转款，但用本项目的设计变量实现：
 * 零动效、无位移、颜色全走变量） */
.mp__probe-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 14px;
  border: 1px solid var(--k12-border-strong);
  border-radius: var(--k12-r-control);
  background: transparent;
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-sm);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__probe-btn:hover:not(:disabled) {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
.mp__probe-btn:disabled {
  opacity: 0.6;
  cursor: progress;
}
.mp__spin {
  animation: mp-spin 0.9s linear infinite;
}
@keyframes mp-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .mp__spin {
    animation: none;
  }
}

.mp__result {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 10px 12px;
  border-radius: var(--k12-r-inset);
  background: var(--k12-good-soft);
  color: var(--k12-good);
}
.mp__result[data-ok='false'] {
  background: var(--k12-warn-soft);
  color: var(--k12-warn);
}
.mp__result-ico {
  flex: none;
  margin-top: 2px;
}
.mp__result-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.mp__result-line {
  font-size: var(--k12-fs-xs);
  font-weight: 650;
}
.mp__result-msg {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}

.mp__foot {
  padding: 12px 18px;
  border-top: 1px solid var(--k12-border);
}
/* 学生视角收尾那句：它是一句说明不是链接，所以用 meta 的字色而不是强调色 */
.mp__hint {
  font-size: var(--k12-fs-xs);
  line-height: var(--k12-lh-body);
  color: var(--k12-muted);
}
.mp__link {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--k12-muted);
  font-size: var(--k12-fs-xs);
  text-align: left;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .mp__link:hover {
    color: var(--k12-accent-ink);
  }
}
.mp-fade-enter-active,
.mp-fade-leave-active {
  transition: opacity 120ms var(--k12-ease-state);
}
.mp-fade-enter-from,
.mp-fade-leave-to {
  opacity: 0;
}
</style>
