<script setup lang="ts">
/**
 * 顶栏：页面标题 + 副标题 + 模型指示器 + 学段指示器（紧凑形态）。
 *
 * ★ 标题与副标题都取自 `stores/ui.ts` 的 `PAGES[ui.page]`（页面清单的唯一来源），
 *   不再来自 `route.meta` —— 本项目没有路由（见 `stores/ui.ts` 头部理由）。
 *
 * ★ 学习类页面（对话 / 动画 / 编程 / 闯关）的副标题是**当前在学什么**，
 *   接真实数据：教材章节（`chat.currentChapter`，来自服务端）。
 *   没有章节时回落成页面清单里的静态副标题 —— 而不是编一句「主题：XXX」出来
 *   （原型里那句来自一个已删除的造数模块）。
 *
 * ★★ 2026-09-22（报告 C1 / 1.2）：副标题里原先把画像端点给的推荐知识点也拼进来
 *   （`建议接着练：<知识点>`），于是它钉在**四页**标题下，而学习记录页的「继续学习」
 *   与对话空态各还有一份 —— 同一事实三处同时可见，且只有后两处是**可点**的。
 *   现在这里**只留章节**（那是环境信息：这段对话在学什么）；练习建议留在能点它的地方。
 *   ⚠️ 别把它加回来：一次行动推荐钉在全局 chrome 上，等于每换一页复读一遍同一个建议。
 *
 * ⚠️ 这一行**只放「当前环境」**：学段（按什么年级的口吻讲）+ 模型（用哪个模型回答）。
 *   **教材章节不在顶栏**：它是「这段对话在学什么」，跟着对话走
 *   （`views/Chat.vue` 的信息条 `.chat__bar` 里，与「本轮对话」同一行 ——
 *   2026-09-22 起那两条并成了一条）。两者都放顶栏 = 同一件事出现两次。
 *   学段的手动入口在 `GradeIndicator` 内部（D-037），**不在**这条顶栏上另开一个控件。
 *
 * ★★ 2026-09-22（报告 1.1）：顶栏业务控件**恰好两枚** —— 模型 chip + 学段 chip。
 *   此前学段是两枚并列控件（实底 badge + 描边触发器「自己指定」），右上角于是挤着
 *   四个同级胶囊（模型 / 学段状态 / 学段动作 / 外壳级跳转），学生分不清哪个是状态。
 *   现在 `GradeIndicator` 自己把状态与动作合成**一枚**可点 chip（见该组件文件头）。
 *   外壳级跳转钮（`view-entry`）仍由 `App.vue` 塞进 actions 插槽，但它已被降权成
 *   描边小按钮 —— 它是**导航**，不与这两枚「当前环境」chip 抢同一档视觉权重。
 *
 * ★ 顶栏是**单行 chrome**（64px，还要与外壳级动作 / 窗口按钮共处一行），所以：
 *   · 学段指示器用 `compact`（只留「学段值 + 我选年级」这一枚 chip，长说明不进这里）；
 *   · 标题与副标题都允许截断（`min-width: 0` + 省略号），
 *     宁可截断标题，也不让右边那枚按钮被挤出窗口（那正是「右侧控件被切掉」的样子）；
 *   · 这一行是窗口拖拽区（无边框窗口）：**每个可点元素**都在各自组件里
 *     声明 `-webkit-app-region: no-drag`，否则点它们会被拖窗吃掉。
 *
 * 原「新会话」按钮已移入 ChatView：它作用于**当前这段对话**，而本顶栏在每一页都
 * 渲染（原实现 emit 了 new-session 但全仓库没有任何地方监听，等于一个死按钮）。
 *
 * ⚠️ 顶栏**不渲染视图切换控件**：三步循环按钮是外壳级动作，由 `App.vue` 从
 *   外壳的 `actions` 插槽塞进来（文案与顺序的唯一来源是 `stores/ui.ts`）。
 *   在这里再写一份标签 = 两处各写一份顺序，迟早「写着去设置、点下去到了学习档案」。
 */
import { computed } from 'vue'
import { Cpu } from 'lucide-vue-next'
import GradeIndicator from './GradeIndicator.vue'
import { PAGES, useUiStore } from '../stores/ui'
import type { PageName } from '../stores/ui'
import { useChatStore } from '../stores/chat'
import { useModelStore } from '../stores/model'
import { useSettingsStore } from '../stores/settings'
import { useViewModeStore } from '../stores/viewMode'
import { chapterLineLabel, llmChipTitle } from '../labels'

const ui = useUiStore()
const chat = useChatStore()
const model = useModelStore()
const settings = useSettingsStore()
const viewMode = useViewModeStore()

const title = computed(() => PAGES[ui.page].title)

/** 学习类页面显示当前主题；其余页面用页面清单里的静态副标题 */
const TOPIC_PAGES = new Set<PageName>(['chat', 'animation', 'coding', 'quiz'])

/**
 * 真实的「正在学什么」：**只有章节那一截**（推荐那截已删，见文件头 ★★）。
 *
 * 只在有数据时才写出来（没有就不写，也没有占位符）：章节用 `chapterLineLabel()`
 * （与章节指示器同一句，唯一实现）。
 * 这里**不发起取数**：章节由对话链路带入，顶栏只读，免得每换一页就多打一次请求。
 */
const topic = computed(() => {
  const chapter = chat.currentChapter.trim()
  return chapter.length > 0 ? chapterLineLabel(chapter) : ''
})

const subtitle = computed(() => {
  const meta = PAGES[ui.page]
  const fallback = meta.subtitle ?? ''
  return TOPIC_PAGES.has(ui.page) ? topic.value || fallback : fallback
})

/**
 * 模型 chip 的悬停说明（**三态 + 随视角分措辞**，唯一实现在 `labels.ts` 的 `llmChipTitle`）。
 *
 * ★ 三种状态各自说自己的话：读取中 / **还没配置模型** / 当前模型。
 *   中间那一档是 2026-09-22 补的（实测缺陷）：此前 chip 直接显示服务端默认的模型名，
 *   于是首次安装、一个 Key 都没填的时候，界面就已经写着 `deepseek-v4-flash` ——
 *   看起来像「配好了」，而学生发出去的第一句会直接失败。
 * ★ 末尾那半句必须**随视角变**：学生视角下模型弹层是只读的
 *   （换模型是老师 / 评委的事，见 `ModelPicker.vue` 与 `stores/viewMode.ts`），
 *   那时还写「点击更换」就是在承诺一件做不到的事 —— 学生点开看到一个
 *   没有可点项的清单，只会以为自己点错了。与 `MessageComposer.vue` 同一口径。
 */
const modelTitle = computed(() => llmChipTitle(settings.snapshot?.llm, viewMode.isTeacher))
</script>

<template>
  <header class="tb" :data-page="ui.page">
    <div class="tb__title-block">
      <h1 class="tb__title">{{ title }}</h1>
      <p v-if="subtitle" class="tb__sub">{{ subtitle }}</p>
    </div>

    <div class="tb__right">
      <!-- 模型指示器：点开看当前模型（教师视角下可直接换）。
           ★ 学生视角下弹层是**只读**的（换模型连带 BaseURL/Key/计费，是老师或家长的事），
             所以 `modelTitle` 也随视角变 —— 学生视角下不再写「点击更换」，
             否则就是承诺一件点不动的事（见 `ModelPicker.vue` 文件头）。 -->
      <!-- 稳定锚点（优化报告 §5.3）：探针按 `topbar-model` 找这颗 chip；
           此前只有类名 `.tb__model`，探针只能靠 `composer-model` 兜底。 -->
      <button
        type="button"
        class="tb__model"
        data-testid="topbar-model"
        :title="modelTitle"
        @click="model.openPicker()"
      >
        <Cpu :size="13" />
        <span class="tb__model-name">{{ model.shortLabel }}</span>
      </button>
      <!-- 学段 chip（合并形态）：一枚可点 chip，点开仍是那个四档抽屉。
           顶栏这一格只显示学段值 —— 来源挪去侧栏身份卡（全应用唯一说来源的地方，报告 2.1）；
           长说明与选项面板要么不进顶栏、要么浮在内容上（见组件内注释）。 -->
      <GradeIndicator compact />
    </div>
  </header>
</template>

<style scoped>
.tb {
  --el-box-shadow-light: none;
  --el-box-shadow: var(--k12-shadow-float);

  height: var(--k12-h-topbar);
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 24px;
  background: var(--k12-surface);
  /* chrome 与内容的分隔用**强边框**（优化报告 §2.1：顶栏加底部 border 增强分隔）。 */
  border-bottom: 1px solid var(--k12-border-strong);
  position: relative;
  z-index: 2;
  color: var(--k12-fg);
  /* ⚠️ 这里**不能**写 `overflow: hidden`：学段下拉与它的一次性提示是浮层，
   *    必须能越过顶栏下沿显示。横向不溢出由 flex 收缩（下面两条）保证，
   *    而不是靠裁切 —— 裁切会把右侧控件切掉一半，那正是要修的毛病。 */
  min-width: 0;
}
.tb__title-block {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.tb__title {
  /* ★ 18px（`--k12-fs-body-lg`）—— 刻意**小于**内容区的身份行（h1 32px），
   *   也小于卡片/区块标题（h3 20px）。
   *
   * 顶栏是 chrome：它回答「你在哪一页」，不回答「这页在讲什么」。
   * 历史：它曾是 18px，而内容区最大只有 16px ⇒ 整页重心落在外壳上；
   * 2026-09-27 按优化报告 §2.1 定为 18px（body-lg）+ fg-2，让 chrome 退到次级层级，
   * 而内容区的最大视觉焦点交给 `.k12-identity`（h1 32px）。 */
  font-size: var(--k12-fs-body-lg);
  font-weight: 650;
  line-height: var(--k12-lh-tight);
  /* 次级层级（优化报告 §2.1：chrome 用 fg-2，主标题才用 fg）。 */
  color: var(--k12-fg-2);
  /* 窄窗口下**截断标题**而不是把右边那排控件挤出窗口 */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 副标题说明「你现在在学什么」，是内容不是装饰，用 fg-2（9.2:1）而非 muted */
.tb__sub {
  font-size: var(--k12-fs-caption);
  line-height: var(--k12-lh-ui);
  color: var(--k12-fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 右侧那一组是「当前环境」：它**不参与收缩**（宁可标题截断），
 * 否则窗口一窄就会把它推到视口外 —— 看起来就是「右侧控件被切掉」。 */
.tb__right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
/* 模型指示器：描边式（透明底 + 发丝描边），与学段 chip（实底胶囊）在形态上分开 ——
 * 两个都要点，但分量不同：模型那枚点开主要是**查看**（换模型连带 BaseURL / Key，
 * 学生视角下弹层是只读的，见 `ModelPicker.vue`），学段那枚点开是**当场改**
 * （D-037，改完立刻生效）。所以模型走描边、学段走实底 + 动作词（样式在 GradeIndicator）。 */
.tb__model {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  /* 内边距跟着字号走（13px 文字 + 上下各 6px ≈ 28px 高的胶囊）——
   * 顶栏高度 72px，控件不能小到「点不准」：它是个要按的东西，不是标签。 */
  padding: 6px 12px;
  border: 1px solid var(--k12-border);
  border-radius: var(--k12-r-pill);
  background: transparent;
  color: var(--k12-fg-2);
  cursor: pointer;
  white-space: nowrap;
  flex: none;
  /* 顶栏整行是窗口拖拽区（无边框窗口）：可点元素必须自己退出拖拽，
   * 否则点在它身上会被窗口拖动吃掉。 */
  -webkit-app-region: no-drag;
}
@media (hover: hover) and (pointer: fine) {
  .tb__model:hover {
    border-color: var(--k12-accent);
    color: var(--k12-accent-ink);
  }
}
/* 模型名是**识别信息**，不是角标 —— 学生要读它才知道现在用的是哪个模型，
 * 所以用 meta 档（`--k12-fs-xs`），而不是角标档。角标档只给 ≤4 字的记号。 */
.tb__model-name {
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-caption);
  font-weight: 600;
}
</style>
