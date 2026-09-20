/**
 * 界面视角：**学生视角（默认）/ 教师·答辩视角**。
 *
 * ---------------------------------------------------------------------------
 * 为什么需要它
 * ---------------------------------------------------------------------------
 * 这个应用里有一批信息是**给评委和老师看的**，不是给学生看的：
 *
 *   · 右栏的「检索降级链」（向量 / 云端 / FTS5 / 依赖图四档）、工具调用轨迹与毫秒耗时；
 *   · 学段判定信号的原样字符串（`t4|答题=连对10,正确率1.0` —— 它是 Python 侧
 *     `encode_turn_raw` 产出的**诊断串**，不是给学生读的句子）；
 *   · 「隔离在 SQL 层强制，模型改不了 WHERE」「kb.sqlite 路径」「端口 / 进程号」。
 *
 * 这些恰恰又是「设计合理性」那 25% 的**核心证据** —— 全删掉等于把答辩材料删了。
 * 所以取舍不是「删或留」，而是**默认给谁看**：学生打开应用看到的是人话，
 * 评委打开开关能看到全部原始信息。
 *
 * ---------------------------------------------------------------------------
 * ★★ 这是「防误入」，**不是权限系统**（不要在文档或答辩里说成权限隔离）
 * ---------------------------------------------------------------------------
 * 本应用**没有账号体系**，渲染进程里的任何开关都是**可绕过的** ——
 * 真正被强制的边界只有三条（都在后端或主进程）：
 * 学段隔离在 SQL 里、判分只在 Python、学生代码只在渲染进程 Worker 里。
 * 本开关**不承担**任何安全职责：它保证的是「学生日常使用不会撞见运维术语」，
 * 而不是「学生拿不到这些数据」。往它身上加鉴权语义是错的 —— 那会让人以为
 * 界面藏起来的东西是安全的。
 *
 * ---------------------------------------------------------------------------
 * 为什么用 localStorage 而不是走 IPC 存进 config.json
 * ---------------------------------------------------------------------------
 * 1. **它纯属界面偏好**，与「这台机器上是谁在用」无关，不该进 `config.json`
 *    （那是 LLM 配置的权威源，由设置页整体重写）；
 * 2. 走 IPC 就要**新增通道**，而通道总数被 `scripts/doc-facts.mjs` 与
 *    `architecture-guards.test.ts` 双重计数 —— 为一个人机工程开关动契约不划算。
 * localStorage 在 Electron 里是**随 userData 目录持久化**的，重启照常保留。
 *
 * ⚠️ 读的时候必须 try/catch：localStorage 在 `file://` + 某些沙箱组合下会抛，
 *    而这是一个「读不到就回默认值」的场景 —— 绝不能因为读偏好失败就让整个应用白屏。
 */
import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'

/** 两种视角：`student` 是默认，`teacher` 才显示技术分节与原始诊断信息。 */
export type ViewMode = 'student' | 'teacher'

/** localStorage 的键（带应用前缀，避免与同源下别的东西撞名）。 */
export const VIEW_MODE_STORAGE_KEY = 'k12.viewMode'

/**
 * 从 localStorage 读初始值。
 *
 * ★ 只认白名单里的两个字面量：读到任何别的东西（旧版本写的、手改的、别的应用
 *   同键写进来的）一律回 `student`。**默认必须是学生视角** ——
 *   判错方向的代价不对称：判成学生视角只是评委多按一下开关，
 *   判成教师视角则是学生直接看到一堆运维术语。
 */
export function readStoredViewMode(): ViewMode {
  try {
    return globalThis.localStorage?.getItem(VIEW_MODE_STORAGE_KEY) === 'teacher'
      ? 'teacher'
      : 'student'
  } catch {
    return 'student'
  }
}

export const useViewModeStore = defineStore('viewMode', () => {
  const mode = ref<ViewMode>(readStoredViewMode())

  /** 是否处于教师 / 答辩视角（模板里读它，别自己比较字面量）。 */
  const isTeacher = computed(() => mode.value === 'teacher')

  /** 「高级设置（教师 / 答辩）」区是否已展开（**纯内存**，不持久化）。 */
  const advancedOpen = ref(false)

  function set(next: ViewMode): void {
    mode.value = next
  }

  /** 学生视角 ↔ 教师视角互切。 */
  function toggle(): void {
    mode.value = mode.value === 'teacher' ? 'student' : 'teacher'
  }

  function openAdvanced(): void {
    advancedOpen.value = true
  }

  function closeAdvanced(): void {
    advancedOpen.value = false
  }

  /** 写完立刻落盘（`watch` 而不是在 set 里写：toggle 也走同一条路）。 */
  watch(mode, (next) => {
    try {
      globalThis.localStorage?.setItem(VIEW_MODE_STORAGE_KEY, next)
    } catch {
      // 写不进去只影响「下次打开还记得吗」，不影响本次会话 —— 不打扰学生。
    }
  })

  return { mode, isTeacher, advancedOpen, set, toggle, openAdvanced, closeAdvanced }
})
