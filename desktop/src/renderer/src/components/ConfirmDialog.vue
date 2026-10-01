<script setup lang="ts">
/**
 * 确认对话框 —— 全站唯一的"要动手之前先问一句"。
 *
 * 为什么必须有它：审计发现**全站此前没有任何 el-dialog / ElMessageBox**，
 * 于是所有破坏性操作（清空会话、重建索引、重置设置）都是**点下去立刻生效、
 * 没有确认、没有撤销**。「新会话」一键抹掉整段对话，学生没有任何反悔机会。
 *
 * 设计取舍（Apple HIG 的 forgiveness 原则）：
 *   · 只在**真的破坏性、且不可撤销**时才弹确认 —— 滥用确认会训练人无脑点确定；
 *   · 危险操作的确认按钮用 danger 色，且默认聚焦在**取消**上；
 *   · 确认文案说清"会发生什么"，不是"你确定吗？"。
 *
 * 用法：
 *   const dlg = useConfirm()
 *   if (await dlg.ask({ title: '...', body: '...', danger: true })) { ...真正执行... }
 * 全局只挂一个实例（App.vue），避免每个页面各写一套。
 */
import { computed, ref } from 'vue'
import { useEscape } from '@/composables/useEscape'
import { useFocusReturn } from '@/composables/useFocusReturn'
import { TriangleAlert, HelpCircle } from 'lucide-vue-next'

const props = withDefaults(
  defineProps<{
    open: boolean
    title: string
    /** 说清"会发生什么"。不要写"你确定吗"这类无信息的话。 */
    body?: string
    /** 不可撤销的破坏性操作：确认键用红色 */
    danger?: boolean
    confirmText?: string
    cancelText?: string
  }>(),
  {
    body: '',
    danger: false,
    confirmText: '',
    cancelText: '取消'
  }
)

const emit = defineEmits<{ (e: 'confirm'): void; (e: 'cancel'): void }>()

const confirmLabel = computed(() => props.confirmText || (props.danger ? '确认删除' : '确认'))

/** Esc 关闭：模态必须有键盘出口，否则键盘用户被卡在里面。 */
useEscape(() => emit('cancel'), () => props.open)

/**
 * 焦点契约（打开移入 → Tab 层内循环 → 关闭归还触发元素）。
 *
 * ★ 文件头那句「危险操作的确认按钮用 danger 色，且默认聚焦在**取消**上」
 *   此前**只有前半句有代码**：没有 `useFocusReturn`、没有初始 `focus()`、
 *   也没有 `tabindex` —— 于是对话框一开，焦点还停在背后的页面上，
 *   一路按回车就是「连点两下确认」（配合 Esc 之外的键盘操作尤其危险）。
 * ★ 初焦点显式给**取消键**而不是「第一个可聚焦元素」：
 *   这里第一个恰好在 DOM 里就是取消键，但那属于**巧合**（改一行模板顺序就变了），
 *   而「危险操作默认落在取消」是本组件的安全契约，必须写死。
 */
const panelRef = ref<HTMLElement | null>(null)
useFocusReturn(panelRef, () => props.open, {
  initial: () => panelRef.value?.querySelector<HTMLElement>('.cd__btn--cancel') ?? null
})
</script>

<template>
  <Teleport to="body">
    <Transition name="cd-fade">
      <div
        v-if="open"
        ref="panelRef"
        class="cd"
        role="dialog"
        aria-modal="true"
        data-testid="confirm-dialog"
        @click.self="emit('cancel')"
      >
        <div class="cd__box k12-float">
          <div class="cd__head">
            <span class="cd__mark" :data-danger="danger">
              <component :is="danger ? TriangleAlert : HelpCircle" :size="17" />
            </span>
            <p class="cd__title">{{ title }}</p>
          </div>

          <p v-if="body" class="cd__body">{{ body }}</p>

          <div class="cd__foot">
            <button
              type="button"
              class="cd__btn cd__btn--cancel"
              data-testid="confirm-no"
              @click="emit('cancel')"
            >
              {{ cancelText }}
            </button>
            <button
              type="button"
              class="cd__btn cd__btn--primary"
              data-testid="confirm-yes"
              :data-danger="danger"
              @click="emit('confirm')"
            >
              {{ confirmLabel }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cd {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* 遮罩：把背景推远，让"现在要做一个决定"这件事成立 */
  background: color-mix(in srgb, var(--k12-fg) 34%, transparent);
}
/* 浮层 = **毛玻璃**（半透明白 + blur）。它背后**真的有东西**：整页内容 + 遮罩，
 * 模糊才有意义；对话框只是「要你决定一件事」，不该把背后的世界变成一堵实墙。
 * ⚠️ 为什么不用 base.css 里那个全局毛玻璃类：scoped 选择器带 `[data-v-x]`，
 *   优先级高于单个全局类 —— 这里必须自己给「兜底 → 半透明」两条，
 *   否则两套机制会打架（谁盖住谁取决于注入顺序，是那种"改一行别处就变色"的坑）。
 *  兜底：不支持 backdrop-filter 的环境保持实色白（半透明底会让下层文字透上来）。 */
.cd__box {
  width: 100%;
  max-width: 420px;
  padding: var(--k12-sp-5);
  display: flex;
  flex-direction: column;
  gap: 14px;
  background: var(--k12-surface);
}
@supports (backdrop-filter: blur(1px)) {
  .cd__box {
    /* 76%：背后是 `--k12-fg 30%` 的遮罩 + 整页（已经压暗过），所以比抽屉更透一档；
     * 决策文字仍落在浅底上，可读性不受影响（分档表见 base.css 的 `.k12-glass`）。 */
    background: color-mix(in srgb, var(--k12-surface) 76%, transparent);
    backdrop-filter: blur(12px) saturate(1.4);
  }
}
.cd__head {
  display: flex;
  align-items: center;
  gap: 11px;
}
.cd__mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--k12-r-pill);
  background: var(--k12-accent-soft);
  color: var(--k12-accent-ink);
}
.cd__mark[data-danger='true'] {
  background: var(--k12-bad-soft);
  color: var(--k12-bad);
}
.cd__title {
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  line-height: var(--k12-lh-snug);
  color: var(--k12-fg);
}
.cd__body {
  font-size: var(--k12-fs-body-sm);
  line-height: var(--k12-lh-body);
  color: var(--k12-fg-2);
}
.cd__foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
.cd__btn {
  padding: 9px 16px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-control);
  background: var(--k12-surface);
  color: var(--k12-fg-2);
  font-size: var(--k12-fs-body-sm);
  font-weight: 600;
  cursor: pointer;
}
@media (hover: hover) and (pointer: fine) {
  .cd__btn:hover {
    border-color: var(--k12-border-strong);
    color: var(--k12-fg);
  }
}
.cd__btn--primary {
  background: var(--k12-accent-ink);
  border-color: var(--k12-accent-ink);
  color: var(--k12-surface);
}
@media (hover: hover) and (pointer: fine) {
  .cd__btn--primary:hover {
    filter: brightness(1.08);
    color: var(--k12-surface);
  }
}
/* 破坏性操作的确认键：红底，与"普通确认"在视觉上分得开，
 * 避免手指记住位置后在危险操作上也一路点下去 */
.cd__btn--primary[data-danger='true'] {
  background: var(--k12-bad);
  border-color: var(--k12-bad);
}
.cd-fade-enter-active,
.cd-fade-leave-active {
  transition: opacity 120ms var(--k12-ease-state);
}
.cd-fade-enter-from,
.cd-fade-leave-to {
  opacity: 0;
}
</style>
