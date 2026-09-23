/**
 * 「桥没接上」时的**接线诊断**：细节进控制台，学生面一个字都不带。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * 为什么单独一个模块（2026-09-22 设计评审报告 0.2 + 双视角纪律 D-063）
 * ══════════════════════════════════════════════════════════════════════════
 * `api/{chapter,grade,study,sessions}.ts` 的 `resolveXxxBridge()` 在 preload 白名单
 * 缺方法时返回 `{ ready: false, message }`，而那条 message **会直接渲染给学生看**
 * （学段 / 章节那两行提示、侧栏的历史对话提示、学习记录的错误行）。
 *
 * 它以前写的是接线说明：「preload 白名单缺少 onChapterChanged，需要先在主进程注册
 * 「章节推送」通道（chapter:changed，由 preload 白名单暴露）……接线后刷新页面即可生效。」
 * ——对**接线的人**这是最有用的那句话（`renderer-chapter.test.ts` 的原话是
 * 「照它就能把线接上」），对**学生**却是噪音：他会读到 `setChapter`、`chapter:changed`、
 * `window.api` 这些他既看不懂、也管不着的东西，而里面那句「接线后刷新页面即可生效」
 * 对他是**假承诺**（他既没有线要接，刷新也真的不会生效）。
 *
 * ★ 处置：**同一件事分两条通路**
 *   · 屏幕：学生话 —— 说清「现在什么用不了 / 还能做什么 / 找谁」，由各 api 文件里的
 *     `*_HINT` 常量给出（它们是学生可见文本，受 `student-view-discipline.test.ts` 守卫）；
 *   · 控制台：缺哪个方法、哪条通道、怎么接 —— 由这里的 {@link warnWiring} 打印，
 *     接线的人在 DevTools 里一眼看到，学生在界面上一个字都看不到。
 *
 * ★ 为什么按 key **各提醒一次**（而不是每次都打 / 只打一条大的）：
 *   · 每次 resolve 都打会刷屏（订阅、切会话、重取章节、学段变化都会 resolve 一次），
 *     真正有用的日志会被冲掉；
 *   · 按 key 分开是必须的：缺的可能只是「写入那一条线」，而先缺的那个 key
 *     会把后缺的整条吞掉（例如只写桥名时 `setChapter` 那条永远不打印）——
 *     一条大日志会让接线的人多读一倍才能看出差在哪。
 */

/** 已提醒过的 key（同一渲染进程内每个 key 只提醒一次）。 */
const warned = new Set<string>()

/**
 * 打一条接线诊断到控制台（同一个 key 只打一次）。
 *
 * @param key 去重键：**每个能力各用各的 key**（`'chapter.push'` / `'chapter.set'`），
 *   别共用桥名。
 * @param detail 给接线人看的细节：缺哪个方法、需要注册哪条通道、接完为什么要重启渲染进程。
 *   ⚠️ 这里是**唯一**可以写方法名 / 通道名 / `window.api` 的地方 —— 别把这段字挪回
 *   `*_HINT`（那边是学生面，守卫会当场变红）。
 */
export function warnWiring(key: string, detail: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.warn(`[k12] 桥未就绪（${key}）：${detail}`)
}

/**
 * 清掉「已提醒过」的记忆。
 *
 * 只给**测试**用（单测里要连着重放同一个缺方法的场景，不去重就看不到 warn）；
 * 产品代码里没有调用点 —— 真机上每个 key 提醒一次正是想要的行为。
 */
export function resetWiringNotices(): void {
  warned.clear()
}
