/**
 * 卡片玻璃光效内核（2026-09-30 设计执行报告 §4.1）。
 *
 * 做两件事，全部通过往卡片根元素写 CSS 自定义属性完成 —— **DOM 结构一个节点都不动**：
 *   1) 边缘定向高光：`--k12-shine-x` / `-y`（光斑中心的卡片局部坐标）+ `--k12-shine-inside`；
 *   2) 四角内凹：`--k12-dent-tl/-tr/-br/-bl`（0–MAX_DENT，px）。
 * 渲染全在 `assets/base.css` 的 `.k12-shine::before/::after` 与 border-radius 里，
 * 所以本文件不碰 DOM 树、不引 SVG filter / backdrop-filter / will-change，
 * 效果走的是浏览器既有的合成路径。
 *
 * ★ 为什么 JS 侧必须读 `useReducedMotion()` 的**有效值**（不能只靠 CSS 媒体查询）：
 *   CSS 的 `@media (prefers-reduced-motion: reduce)` 只收得掉 **CSS** 的时长，
 *   收不掉 `requestAnimationFrame` —— 减动效用户的卡片照样会跟着鼠标连续变形。
 *   这里的口径与报告 §2.4 一致：减动效开启 = **整个效果不挂监听**（不做降级形态），
 *   用户在设置页切三档开关时立即挂上/摘下（生效门是 watch 的 source）。
 *
 * ★ 性能口径（报告 §5 红线 7）：
 *   · `pointermove` 一律 passive —— 不因为「可能 preventDefault」而阻塞滚动；
 *   · rAF **单例**：一帧最多算一次，指针事件再密也只提交一次调度；
 *   · **收敛即停帧**：所有增量小于 EPSILON 就停 rAF，不留常驻动画循环
 *     （下一次 pointermove 会重新调度，所以跟随手感不受影响）；
 *   · 每帧只读一次 `getBoundingClientRect()`，且**先读后写**（读几何 → 写变量），
 *     读写不交错，避免强制同步布局。
 *
 * ★ 两个纯函数（{@link cornerDent} / {@link edgeProximity}）与组合式函数同文件导出：
 *   几何公式与报告 §2.3 的参数表一一对应，单测直接测它们（`tests/card-shine.test.ts`）。
 */
import { computed, onBeforeUnmount, watch, type Ref } from 'vue'
import { useReducedMotion } from './useReducedMotion'

/**
 * 单角最大内凹量（px）。
 *
 * ★ 2026-09-30 用户裁决：报告 §2.3 的 5px **幅度太低**（真机上几乎看不出角被压下去），
 *   加到 **12px**：基础圆角 12px，贴角时 12 → 24px，肉眼明确读得出「这个角被按进去了」。
 *   衰减曲线（二次）与 FALLOFF 不动 —— 要改的是「压多少」，不是「压多远」。
 */
const MAX_DENT = 12
/** 角落衰减半径（px）：指针离角超过它，该角完全不凹。 */
const FALLOFF = 120
/** 近边线性区间（px）：离最近边的距离超过它，内部光泽不再增强。 */
const EDGE_NEAR = 64
/** 内部光泽的强度系数：0.5 × `--k12-shine-wash` 的 16% = 有效 ≤8% 白（对比度预算见 §2.3）。 */
const INSIDE_SCALE = 0.5
/** 每帧插值系数：0.2 ≈ 100ms 跟随感（比「卡」快，比「瞬移」柔）。 */
const LERP = 0.2
/** 收敛阈值（px）：所有增量都小于它就停帧。 */
const EPSILON = 0.01
/**
 * 整卡 3D 倾斜的最大角度（deg）。
 *
 * ★ 2026-09-30 用户裁决：「我想要类似于 3D 卡片整体往后面一个角内凹的那种效果」——
 *   只把圆角变大读不出「被按进去」；要让**整张卡片**绕中轴轻微倾斜：指针在哪一侧，
 *   那一侧的角就往后倒（透视下变小），四角内凹是它的加强。
 *   ★ 2026-09-30 用户裁决二次下调：5° → **2.5°**（5° 的倾倒感偏强，读起来像卡片要翻过去；
 *     2.5° 配合 900px 透视时，854px 宽的卡片边缘前后位移约 18px —— 立体仍在，但只是「轻轻一压」。
 *     内凹幅度（MAX_DENT=12）不受影响：那才是「被按进去」的主信号，倾斜只负责给立体方向。）
 */
const MAX_TILT = 2.5
/**
 * 倾斜允许把「离中心最远的边」甩出去的最大像素数（按元素尺寸反推角度上限）。
 *
 * ★ 为什么需要它：透视倾斜的位移与**元素跨度**成正比 —— 普通卡片几百像素无所谓，
 *   而一万像素高的长卡转 2.5° 会把远端甩出两百多像素（用户报「卡片自己移动到下面去」）。
 *   12px 是「看得出立体、又不可能读成位移」的量。
 */
const TILT_MAX_SHIFT_PX = 12

/** 夹到 0–1（非有限值在调用链上不会出现，这里只挡越界）。 */
/** 夹到 -1..1（整卡倾斜用：指针可能跑到卡外，角度不能继续放大）。 */
const clampSigned = (value: number): number => (value < -1 ? -1 : value > 1 ? 1 : value)

/** 夹到 0–1（非有限值在调用链上不会出现，这里只挡越界）。 */
const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value)

/**
 * 单角内凹量（px，0–MAX_DENT）：**二次衰减** —— 只有真贴近角时才明显。
 *
 * `d = 指针到角的距离`；`d ≥ FALLOFF` 得 0（clamp01 把负值压回 0，不是负数内凹）。
 *
 * @param px 指针在卡片内的局部坐标 x
 * @param py 指针在卡片内的局部坐标 y
 * @param cx 角顶点 x（0 或卡片宽）
 * @param cy 角顶点 y（0 或卡片高）
 */
/**
 * 光效的**每实例**参数（2026-09-30：对话气泡也要这套效果，但要克制）。
 *
 * 缺省 = 卡片那一套（12px 内凹 / 5° 倾斜 —— 注意卡片自己后来把倾斜定成 2.5°，见 MAX_TILT）；
 * 对话气泡传 `{ maxDent: 6, maxTilt: 1, falloff: 90 }`：气泡比卡片小得多，同样的幅度会显得夸张。
 */
export interface ShineOptions {
  maxDent?: number
  maxTilt?: number
  falloff?: number
}

export function cornerDent(
  px: number,
  py: number,
  cx: number,
  cy: number,
  maxDent: number = MAX_DENT,
  falloff: number = FALLOFF
): number {
  const distance = Math.hypot(px - cx, py - cy)
  const t = clamp01(1 - distance / falloff)
  return maxDent * t * t
}

/**
 * 近边强度（0–1，线性）：指针离**最近的边**越近越接近 1。
 *
 * 这个值乘上 {@link INSIDE_SCALE} 之后写进 `--k12-shine-inside`，
 * 决定卡面内部那层白光泽的透明度（对比度预算见报告 §2.3）。
 */
export function edgeProximity(px: number, py: number, w: number, h: number): number {
  const edgeDistance = Math.min(px, py, w - px, h - py)
  return clamp01(1 - edgeDistance / EDGE_NEAR)
}

/**
 * 给一个卡片根元素挂上玻璃光效（指针跟随）。
 *
 * @param el      卡片根元素（模板 ref）
 * @param enabled 接入方开关（`SurfacePanel` 的 `shine` prop）；缺省视为 true。
 *                它和减动效有效值是**与**的关系：任一为假 → 摘监听并归零。
 */
export function useCardShine(
  el: Ref<HTMLElement | null>,
  enabled?: Ref<boolean>,
  opts: ShineOptions = {}
): void {
  const reduced = useReducedMotion()
  // 每实例幅度（缺省 = 卡片档；对话气泡传更克制的数，见 ShineOptions）
  const maxDent = opts.maxDent ?? MAX_DENT
  const maxTilt = opts.maxTilt ?? MAX_TILT
  const falloff = opts.falloff ?? FALLOFF

  /** rAF 句柄（0 = 当前没有排队的帧）。既是单例标志，也是卸载时要取消的那个。 */
  let frame = 0
  /** 真正绑过监听的那个元素：摘监听认它而不是 `el.value`（元素换了也不会漏摘）。 */
  let bound: HTMLElement | null = null

  /**
   * 卡片的**未变形**几何（缓存）。
   *
   * ★★ 为什么必须缓存 + 必须在**父元素**上听事件（2026-09-30 真机实测的反馈环）：
   *   整卡 3D 倾斜会把**指针那一侧的角往后推**（这正是要的效果），而浏览器的命中测试跟着
   *   变形后的轮廓走 —— 指针离角只有十几像素时，角一往后倒，指针就落到卡片**外面**：
   *   pointerleave → 目标归零 → 卡片弹回 → 指针又落回卡上 …… 效果在角上自己跟自己打架。
   *   实测表现极具误导性：右下角能稳定触发，**左上角完全触发不了**（`elementFromPoint`
   *   落在滚动容器上，看起来像「效果坏了」）。
   *   所以：监听绑在父元素上，几何用「进卡那一刻量下的那份」——那时倾斜≈0，就是未变形的盒子；
   *   指针在不在卡上完全由这份缓存判定，被按的角因此可以放心往后倒。
   */
  let geo = { left: 0, top: 0, width: 0, height: 0 }
  const measure = (): void => {
    const node = el.value
    if (node === null) return
    const rect = node.getBoundingClientRect()
    geo = { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  }
/** 事件挂哪：父元素优先（理由见上）。父元素不存在时退回元素自己（至少还有 hover 语义）。 */
  const listenTarget = (): HTMLElement | null => el.value?.parentElement ?? el.value
  /** 指针此刻是否在卡上 —— 判据是**缓存盒子**，不是浏览器的 hover（见上）。 */
  let onCard = false
  /** 最后一次指针的视口坐标：滚动/缩放后要按它重算，不能凭旧几何猜。 */
  let lastX = 0
  let lastY = 0
  /**
   * 窗口尺寸 / 容器滚动：缓存的盒子立刻作废（卡片位置变了），重测并把效果归位。
   * 滚动中不重测的话，几何会按旧位置算 —— 表现是「光斑粘在错的地方」。
   */
  const onViewportChange = (): void => {
    measure()
    // 还在卡上：按最后一次指针位置重算（卡片位置变了，光斑要跟着走，而不是被打回原形）。
    // 不在卡上：只更新几何。
    if (onCard) applyPointer(lastX, lastY)
    schedule()
  }

  // 平滑状态（当前值 / 目标值）：光斑坐标、四角内凹、内部光泽强度。
  // glint = 四角内凹量的**归一化峰值**（0–1）：CSS 用它给「角上那束高光」定强度。
  // ★ 为什么由 JS 给：CSS 拿不到「四个角里最大的那个」（没有 max() 能跨自定义属性取最大值），
  //   而角上的高光必须跟着内凹一起长 —— 所以这里算一次、CSS 只用。
  // tiltX/tiltY：整卡 3D 倾斜（deg，带符号）—— 指针那侧的角往后倒。
  const cur = { x: 0, y: 0, tl: 0, tr: 0, br: 0, bl: 0, inside: 0, glint: 0, tiltX: 0, tiltY: 0 }
  const tgt = { ...cur }
  const FIELDS = Object.keys(cur) as (keyof typeof cur)[]

  /**
   * 把当前值写进元素 —— **唯一的写入口**。
   *
   * `node` 可以显式传入：摘监听时要把**旧元素**归零（那时 `el.value` 可能已经换人）。
   * 光斑坐标用 -999px 表示「不在这张卡上」（与 CSS 里的缺省值同一个约定）。
   */
  const setVars = (node: HTMLElement | null = el.value): void => {
    if (node === null) return
    node.style.setProperty('--k12-shine-x', `${cur.x.toFixed(1)}px`)
    node.style.setProperty('--k12-shine-y', `${cur.y.toFixed(1)}px`)
    node.style.setProperty('--k12-shine-inside', cur.inside.toFixed(3))
    node.style.setProperty('--k12-dent-tl', `${cur.tl.toFixed(2)}px`)
    node.style.setProperty('--k12-dent-tr', `${cur.tr.toFixed(2)}px`)
    node.style.setProperty('--k12-dent-br', `${cur.br.toFixed(2)}px`)
    node.style.setProperty('--k12-dent-bl', `${cur.bl.toFixed(2)}px`)
    node.style.setProperty('--k12-shine-glint', cur.glint.toFixed(3))
    node.style.setProperty('--k12-shine-tilt-x', `${cur.tiltX.toFixed(2)}deg`)
    node.style.setProperty('--k12-shine-tilt-y', `${cur.tiltY.toFixed(2)}deg`)
  }

  /** 目标态全部归位：光斑移出画面、四角弹回、光泽熄灭（离开与摘监听共用）。 */
  const clearTargets = (): void => {
    tgt.x = -999
    tgt.y = -999
    tgt.tl = 0
    tgt.tr = 0
    tgt.br = 0
    tgt.bl = 0
    tgt.inside = 0
    tgt.glint = 0
    tgt.tiltX = 0
    tgt.tiltY = 0
  }

  /**
   * 一帧：向目标插值（lerp）→ 写变量 → 决定还要不要下一帧。
   *
   * ★ 收敛即停帧（红线 7）。施工图草稿的条件是「收敛**且指针不在卡上**」，这里收紧成
   *   「只要收敛就停」：指针停在卡上不动时，剩余增量已经小于 EPSILON，继续跑 rAF 就是
   *   空转（卡片多时是可以量出来的浪费）；而每次 pointermove 都会重新 {@link schedule}，
   *   所以跟随手感与草稿完全一致。回弹（指针已离开、目标全零）同样靠这条路径收敛停帧。
   */
  const tick = (): void => {
    let settled = true
    for (const key of FIELDS) {
      const delta = tgt[key] - cur[key]
      if (Math.abs(delta) > EPSILON) settled = false
      cur[key] += delta * LERP
    }
    if (settled) {
      // 抹平残差：否则会留下 0.009px 这类「永远差一点」的尾巴
      for (const key of FIELDS) cur[key] = tgt[key]
      setVars()
      // 停下之前若已不在卡上，顺手重测一次几何（此刻倾斜已归零 → 量到的就是未变形盒子）。
      // 这也让「指针离开后」的那一次收敛成为缓存的刷新点，不必额外加定时器。
      if (!onCard) measure()
      frame = 0
      return
    }
    setVars()
    frame = requestAnimationFrame(tick)
  }

  /** 单例调度：已经有一帧在排队就什么都不做（一帧最多算一次）。 */
  const schedule = (): void => {
    if (frame === 0) frame = requestAnimationFrame(tick)
  }

  /**
   * 指针事件 → 目标值。
   *
   * 只读**一次** rect 并把四个角一次算完：先读后写，避免在读写之间触发同步布局。
   */
  const applyPointer = (clientX: number, clientY: number): void => {
    const node = el.value
    if (node === null) return
    lastX = clientX
    lastY = clientY
    // ★★ 几何什么时候现量（真机踩到的第二个坑）：
    //   监听到父元素之后，**pointerenter 不再逐卡触发**（指针早就停在那个大容器里了），
    //   于是「进卡先量一次」这条路走不到 —— 几何会一直停在**挂载时**量到的那份，
    //   而挂载那一刻卡片往往还没布局（宽高 0）⇒ 之后每次移动都被判成「出界」，效果整个不出现
    //   （症状：指针明明在卡上，写出来的却是 -999px）。
    //   所以：**没在卡上时、或量到的是零尺寸时，每次移动都现量**（一次 getBoundingClientRect）；
    //   已经在卡上就不再量 —— 那时卡片是**变形**的，量出来的盒子会喂回反馈环。
    if (!onCard || geo.width === 0) measure()
    const rect = geo
    const px = clientX - rect.left
    const py = clientY - rect.top
    // 事件挂在父元素上，所以「指针还在不在卡上」要自己判（用未变形的缓存盒子）。
    // 出界等价于 leave：目标归零、卡片弹回。
    if (px < 0 || py < 0 || px > rect.width || py > rect.height || rect.width === 0) {
      onCard = false
      clearTargets()
      schedule()
      return
    }
    onCard = true
    tgt.x = px
    tgt.y = py
    // 四角各自独立：指针贴近哪个角，只有那个角凹（对角保持原样）
    tgt.tl = cornerDent(px, py, 0, 0, maxDent, falloff)
    tgt.tr = cornerDent(px, py, rect.width, 0, maxDent, falloff)
    tgt.br = cornerDent(px, py, rect.width, rect.height, maxDent, falloff)
    tgt.bl = cornerDent(px, py, 0, rect.height, maxDent, falloff)
    // 角上的高光强度：四个角里最深的那个（按本实例的幅度归一化）。
    // ★ maxDent 可以是 0（窗口那三颗玻璃圆钮只要「高光跟着指针走」、不要任何形变）——
    //   那时 0/0 会算出 NaN 并一路写进变量，所以显式短路成 0。
    tgt.glint = maxDent > 0 ? Math.max(tgt.tl, tgt.tr, tgt.br, tgt.bl) / maxDent : 0
    // 整卡倾斜：指针相对卡心的偏移（-1..1）→ 角度；指针在哪侧，那侧往后倒。
    const nx = rect.width > 0 ? (px - rect.width / 2) / (rect.width / 2) : 0
    const ny = rect.height > 0 ? (py - rect.height / 2) / (rect.height / 2) : 0
    // ★★ 倾斜要**按元素尺寸封顶**（2026-10-01 真机缺陷）：
    //   `perspective(900px)` 下，倾斜 θ 会把离中心最远的边甩出 `跨度/2 × sinθ` 的距离 ——
    //   卡片 417px 高时是几像素（无感），而参考资料库那张卡有 **10474px** 高：
    //   2.5° 直接把它远端甩出 ~230px，用户看到的就是「卡片自己移动到下面去」。
    //   所以这里按最大跨度反推角度上限，保证**远端位移不超过 TILT_MAX_SHIFT_PX**；
    //   尺寸正常的卡片（跨度 < ~550px）算出来仍是不受影响的 maxTilt。
    const halfSpan = Math.max(rect.width, rect.height) / 2
    const tiltCap =
      halfSpan > 0 ? (Math.atan2(TILT_MAX_SHIFT_PX, halfSpan) * 180) / Math.PI : maxTilt
    const effTilt = Math.min(maxTilt, tiltCap)
    tgt.tiltY = clampSigned(nx) * effTilt
    tgt.tiltX = -clampSigned(ny) * effTilt
    tgt.inside = edgeProximity(px, py, rect.width, rect.height) * INSIDE_SCALE
  }

  const onPointerMove = (event: PointerEvent): void => {
    applyPointer(event.clientX, event.clientY)
    schedule()
  }

  const onPointerEnter = (event: PointerEvent): void => {
    // ★ 进卡先量一次（此刻倾斜≈0，量到的就是未变形盒子），再用 enter 自带的坐标起步：
    //   卡片在指针底下滚出来时不会有 pointermove，干等会让光效「先跳到上一次的位置再跟手」。
    measure()
    applyPointer(event.clientX, event.clientY)
    schedule()
  }

  const onPointerLeave = (): void => {
    onCard = false
    clearTargets()
    schedule()
  }

  /** 挂监听（幂等）：换元素时先摘旧的，避免监听器留在旧节点上。 */
  const bind = (): void => {
    const node = listenTarget()
    if (node === null || node === bound) return
    unbind()
    measure()
    bound = node
    node.addEventListener('pointermove', onPointerMove, { passive: true })
    node.addEventListener('pointerenter', onPointerEnter)
    node.addEventListener('pointerleave', onPointerLeave)
    window.addEventListener('resize', onViewportChange, { passive: true })
    // capture: 滚动事件不冒泡，捕获阶段才收得到容器内部的滚动
    window.addEventListener('scroll', onViewportChange, { passive: true, capture: true })
  }

  /** 摘监听 + 取消 rAF + 归零（`onBeforeUnmount` 与生效门关闭共用）。 */
  const unbind = (): void => {
    const node = bound
    bound = null
    onCard = false
    if (frame !== 0) {
      cancelAnimationFrame(frame)
      frame = 0
    }
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, { capture: true })
    if (node === null) return
    node.removeEventListener('pointermove', onPointerMove)
    node.removeEventListener('pointerenter', onPointerEnter)
    node.removeEventListener('pointerleave', onPointerLeave)
    // ★ 为什么必须归零：这几个变量写在**行内 style** 上，CSS 的减动效媒体查询收不掉它 ——
    //   不归零的话，关掉接入开关 / 打开减动效之后卡片会**卡在最后一次的变形上**。
    clearTargets()
    for (const key of FIELDS) cur[key] = tgt[key]
    setVars(node)
  }

  /**
   * 生效门 = 接入方开关（缺省视为开）**与** 减动效有效值。
   *
   * 用 `watch(..., { immediate: true })` 内联实现（报告明确不要照抄那个抛异常的占位函数）：
   * 门一关就摘监听并归零，门一开就重新挂上 —— 设置页切三档开关当场生效。
   */
  const gate = computed<boolean>(
    () => (enabled === undefined ? true : enabled.value !== false) && !reduced.value
  )

  watch(
    [el, gate],
    ([node, on]) => {
      if (node !== null && on) bind()
      else unbind()
    },
    // flush: 'post' —— 模板 ref 要等 DOM 补丁完才指向真元素；它一被赋值就会走到这里
    { immediate: true, flush: 'post' }
  )

  onBeforeUnmount(unbind)
}
