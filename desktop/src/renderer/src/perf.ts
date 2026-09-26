/**
 * 性能埋点（优化报告 §5.2 阶段 14.3：FCP / LCP / FID + 真机探针 + 基准线）。
 *
 * ---------------------------------------------------------------------------
 * 为什么自己写三行、不引 web-vitals
 * ---------------------------------------------------------------------------
 * 渲染进程已经有一份体积预算（`tests/monaco-bundle.test.ts` 盯着编辑器 chunk），
 * 而我们要的三个数在 `PerformanceObserver` 上都是标准事件：多引一个依赖只为包一层
 * 减法不划算。这里只做**采集 + 暴露**，不做上报（本应用不联网上报任何东西 ——
 * 学生数据不出本机，这是产品承诺）。
 *
 * ★ 采集到的快照同时挂在 `window.__k12Perf` 上：真机探针（`ux-probe-perf.mjs`）
 *   通过 CDP 读它，就不必在探针里重写一遍三个 metric 名字。
 * ★ 任何一个 Observer 不被支持都不许抛：性能埋点坏掉不能影响学生用应用。
 */

export interface PerfSnapshot {
  /** First Contentful Paint（ms，相对导航开始）。 */
  fcp: number | null
  /** Largest Contentful Paint（ms；取观测到的最大值 = 最后一次上报）。 */
  lcp: number | null
  /** First Input Delay（ms；学生第一次点击/按键之前没有值）。 */
  fid: number | null
}

const snapshot: PerfSnapshot = { fcp: null, lcp: null, fid: null }

/** 当前快照（拷贝一份 —— 调用方拿到的不该是可变引用）。 */
export function performanceSnapshot(): PerfSnapshot {
  return { ...snapshot }
}

/** 装三个观察器（幂等：重复调用不会重复订阅）。 */
export function observePerformance(): void {
  if (typeof window === 'undefined' || typeof PerformanceObserver === 'undefined') return
  if ((window as unknown as { __k12PerfReady?: boolean }).__k12PerfReady === true) return
  ;(window as unknown as { __k12PerfReady?: boolean }).__k12PerfReady = true

  const observe = (type: string, handler: (entries: PerformanceEntryList) => void): void => {
    try {
      const observer = new PerformanceObserver((list) => handler(list.getEntries()))
      observer.observe({ type, buffered: true })
    } catch {
      /* 该类型不被支持（老 Chromium / 非浏览器环境）：跳过这一项 */
    }
  }

  observe('paint', (entries) => {
    for (const entry of entries) {
      if (entry.name === 'first-contentful-paint') snapshot.fcp = entry.startTime
    }
    // paint 事件在导航早期就发生完，拿到就可以停（避免长期挂着一个观察器）
    publish()
  })
  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1]
    // LCP 会随页面变化持续上报：保留**最新一次**（= 有内容的最大绘制时刻）
    if (last) snapshot.lcp = last.startTime
    publish()
  })
  observe('first-input', (entries) => {
    const first = entries[0] as (PerformanceEntry & { processingStart?: number }) | undefined
    if (first) {
      // FID = 输入到开始处理之间的延迟（processingStart - startTime）
      const delay =
        typeof first.processingStart === 'number' ? first.processingStart - first.startTime : 0
      snapshot.fid = Math.max(0, delay)
    }
    publish()
  })
}

/** 把快照挂到 window 上（探针读它；没有 window 时静默跳过）。 */
function publish(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as { __k12Perf?: PerfSnapshot }).__k12Perf = performanceSnapshot()
}
