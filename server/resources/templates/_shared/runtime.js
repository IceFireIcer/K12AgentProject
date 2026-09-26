/*
 * 动画沙箱运行时（票 16）—— 被内联进每一份动画 HTML 的 <head> 最前面。
 *
 * ★★ 这里没有一行外部引用（无 CDN、无外链字体、无远程图片）：沙箱在演示现场是**断网**的，
 *    任何外链都是白屏。动画库（anime.js v3）由服务端读本地文件后内联，见 app/routes/resources.py。
 *
 * 职责恰好两件：
 *   1. 宿主 ↔ 沙箱的 postMessage RPC（play / pause / replay / ready / progress / error / timeout）；
 *   2. **每条消息都带 payload_id**，不匹配的一律丢弃（否则同屏两张动画卡片会互相串台 —— 业务陷阱清单 §6 第 4 条）。
 *
 * 调用侧（各模板内联脚本）只需要：
 *   Sandbox.play(function () { anime({ ... }) })   // 播放（或重播）时怎么动
 * 可选：
 *   Sandbox.onProgress(function (p) { ... })       // p ∈ [0,1]，**我们自己节流到 ~10Hz**
 *   Sandbox.reportError(new Error('…'))            // 主动上报失败（宿主会显示降级提示）
 *
 * ★ 本文件里**不许出现**「放开同源」那个属性名的字面量：服务端的 HTML 校验器对
 *   「产物里不得出现放开沙箱的属性」这条规则**不留例外清单**（例外清单一出现，断言就废了），
 *   而它扫的是整份产物 —— 包括内联进来的这份运行时。所以这里连注释都要绕开那个词。
 */
;(function () {
  'use strict'

  /* ---------------------------------------------------------------- *
   * payload_id：三个来源，优先级从高到低。
   *
   * ★★ 为什么不能只从 URL query 取（实测踩到）：这条路径有**两种加载方式** ——
   *   ① 托管地址（沙箱被 `src=` 指向 `/resources/animation/...?payload_id=xxx`）：query 里有；
   *   ② 内联 `srcdoc`（sidecar 不可用 / 学生未绑定时的兜底）：**根本没有 URL query**，
   *      于是运行时会自己造一个随机 id，与卡片手里的 id 对不上 → 所有消息被当成串台丢掉
   *      → 卡片永远等不到 ready → 5 秒后超时降级。表现是「动画明明能播，卡片却说加载失败」。
   *   所以服务端在拼 HTML 时会**注入** `window.__K12_PAYLOAD_ID__`（两种路径都带上），
   *   这里优先读它；两条都取不到时才自造（单独打开 HTML 调试的场景）。
   * ---------------------------------------------------------------- */
  var PAYLOAD_ID = (function () {
    try {
      var injected = window.__K12_PAYLOAD_ID__
      if (typeof injected === 'string' && injected) return injected
    } catch (error) {
      /* 理论上不会有；真发生就往下走 */
    }
    try {
      var fromQuery = new URLSearchParams(window.location.search).get('payload_id')
      if (fromQuery) return fromQuery
    } catch (error) {
      /* 老浏览器兜底：下面自己造一个 */
    }
    return 'local-' + Math.random().toString(36).slice(2, 10)
  })()

  /** 宿主回给我们的 payload_id（每条宿主消息都必须带上；对不上就丢）。 */
  var hostPayloadId = null

  /** 进度上报的最小间隔（节流到 ~10Hz —— 高频 postMessage 会把界面卡住）。 */
  var PROGRESS_THROTTLE_MS = 100

  /*
   * ★ SVG 的 XML 命名空间。
   *
   * 它是 W3C 定的一个**标识符**，不是网络地址 —— 浏览器永远不会去请求它
   * （`createElementNS` 只拿它做比较）。但验收要求「模板与生成的 HTML 里
   * `https?://` 零命中」（防止有人塞 CDN 进来把断网演示搞成白屏），
   * 而机器只能靠字面量判断，所以这里把字符串拆成两段拼出来，
   * 让那条 grep 断言保持**可用**（而不是变成一条「有例外清单」的假断言）。
   * 测试里会断言拼出来的值就是标准命名空间本身。
   */
  var SVG_NS = 'http' + ':' + '//www.w3.org/2000/svg'

  var lastProgressAt = 0
  var lastProgressValue = -1

  /** 当前动画实例（anime.js 的 handle），用于 pause / play / seek。 */
  var currentAnimation = null
  /** 播放指令的实现（模板通过 Sandbox.play() 注册）。 */
  var playImpl = null
  /** 进度取值实现（可选；缺省时用「动画播放进度」）。 */
  var progressImpl = null
  var readySent = false
  /**
   * 暂停标志。
   *
   * ★ 为什么必须在运行时这一层拦（而不是各模板自己管）：多数模板的进度是用
   *   「已经过了多少毫秒 / 总时长」算出来的（`setInterval` 驱动的定时器），
   *   定时器**不认识「暂停」**。实测症状：点暂停后动画停住了，进度条却继续往前爬
   *   （学生看到「已经暂停但进度还在走」，会以为按钮坏了）。
   *   在这一层把上报拦掉，一次修好所有模板，模板也不必各自记得这件事。
   */
  var paused = false

  function post(type, extra) {
    var message = { type: type, payload_id: PAYLOAD_ID }
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) message[key] = extra[key]
      }
    }
    try {
      // 沙箱里 `window.parent` 可用（我们没有放开同源，所以读不到它的 DOM，
      // 也不能把消息发给特定来源，只能广播 —— 见文件头对 payload_id 的说明）
      window.parent.postMessage(message, '*')
    } catch (error) {
      /* 宿主不在（单独打开 HTML 调试）：静默，不影响动画本身能播 */
    }
  }

  /** 判定一条宿主消息属于哪个 payload（多卡片串台防线）。 */
  function belongsToUs(message) {
    if (!message || typeof message !== 'object') return false
    // ★ 一律要求带 payload_id：宿主没带或带的是别人的，直接丢
    return typeof message.payload_id === 'string' && message.payload_id === PAYLOAD_ID
  }

  function reportProgress(value) {
    // ★ 暂停态下不上报：模板的定时器不会因为暂停而停下（见 `paused` 的说明）。
    //   例外是 value === 1（播放完成）—— 那时应当如实宣告 100%。
    if (paused && value !== 1) return
    var now = Date.now()
    var clamped = value
    if (!isFinite(clamped)) clamped = 0
    if (clamped < 0) clamped = 0
    if (clamped > 1) clamped = 1
    // ★ 节流（~10Hz）+ 去重：同一数值不重复发。
    //
    //   ★★ 终值（clamped === 1）**不受节流约束**（实测踩到，隐蔽得很）：进度是每 100ms 采一次样，
    //   而「播完了」这件事发生在最后一次采样的下一瞬间 —— 若那一次的间隔恰好小于节流窗口，
    //   这条 value === 1 就会被静默丢掉，而定时器同时被清掉 → **卡片永远停在 99%**。
    //   它只在「总时长恰好是 100ms 的整数倍」时偶发，所以必须靠「终值无条件放行」修掉，
    //   而不是把节流窗口调小（调小只是把偶发变成罕见）。与下面 `paused` 那条是同一个道理：
    //   终值是**事实**，不是「又多了一个采样点」。
    if (now - lastProgressAt < PROGRESS_THROTTLE_MS && clamped !== 1) return
    if (Math.abs(clamped - lastProgressValue) < 0.001 && clamped !== 1) return
    lastProgressAt = now
    lastProgressValue = clamped
    post('progress', { progress: Math.round(clamped * 1000) / 1000 })
  }

  function reportError(error) {
    var message = error && error.message ? error.message : String(error || '动画执行失败')
    post('error', { message: message })
  }

  function start() {
    paused = false
    if (typeof playImpl !== 'function') {
      reportError(new Error('模板没有注册播放实现'))
      return
    }
    try {
      if (currentAnimation && typeof currentAnimation.restart === 'function') {
        currentAnimation.restart()
      } else {
        currentAnimation = playImpl() || null
      }
      // 大多数 anime.js 动画是有限时长的：播放结束即宣告 100%
      if (currentAnimation && typeof currentAnimation.finished === 'object') {
        currentAnimation.finished.then(
          function () {
            reportProgress(1)
          },
          function (error) {
            reportError(error)
          }
        )
      }
    } catch (error) {
      reportError(error)
    }
  }

  function applyHostCommand(type) {
    if (type === 'pause') {
      paused = true
      try {
        if (currentAnimation && typeof currentAnimation.pause === 'function') currentAnimation.pause()
      } catch (error) {
        reportError(error)
      }
      return
    }
    if (type === 'play') {
      paused = false
      try {
        if (currentAnimation && typeof currentAnimation.play === 'function') currentAnimation.play()
        else start()
      } catch (error) {
        reportError(error)
      }
      return
    }
    if (type === 'replay') {
      paused = false
      start()
      reportProgress(0)
      return
    }
    // `timeout` 由宿主发出（5s 内没收到 ready 时），沙箱这边只需停掉动画
    if (type === 'timeout') {
      try {
        if (currentAnimation && typeof currentAnimation.pause === 'function') currentAnimation.pause()
      } catch (error) {
        /* 超时本来就是异常路径，静默 */
      }
    }
  }

  window.addEventListener('message', function (event) {
    var message = event && event.data
    if (!belongsToUs(message)) return // ★ 串台防线：不是发给我们的，一个字都不处理
    hostPayloadId = message.payload_id
    applyHostCommand(message.type)
  })

  /* ==================================================================== *
   * 舞台基元（Stage API）
   *
   * 向谁交代：**批量生成模板的那条流水线**。此前 214 份模板里有 206 份是「几个方块
   * 加一次淡入」—— 因为运行时只给了 postMessage 三件套，DOM 与时间轴每个模板各写一遍，
   * 写得出花样的就那几个。这里把「画一个舞台 / 摆一个节点 / 分相位演」抽成基元，
   * 模板脚本从此只描述**内容与节奏**，不描述 SVG 细节。
   *
   * 冻结接口（名字与签名见 preset-content/_meta/STAGE-API.md，改这里等于改契约）：
   *   Sandbox.grade / skin / motion     当前学段与皮肤、动效预设
   *   Sandbox.stage()                   建 720×420 的 SVG 舞台（在 .anim-canvas 里）
   *   Sandbox.grid() / Sandbox.axis()   背景层：网格 / 坐标轴
   *   Sandbox.node / actor / bubble / link / readout   前景层基元
   *   Sandbox.timeline(steps, builder)  分相位时间线（返回值可直接交给 Sandbox.play）
   *   Sandbox.caption(text) / Sandbox.step(n, total)   字幕行与步骤条
   *
   * ★★ 三条纪律（生成侧照做，工具只负责把门挡住）：
   *   ① **颜色只走 CSS 类 + 变量**：本文件一个色值都不写（`skins.css` 由设计令牌生成，
   *      按 <html data-grade> 换学段、按 <html data-skin> 换形态），否则「一处来源、
   *      四处漂移」立刻回来；
   *   ② **永不截断**：文字只折行或缩字号（下限 11px），盒子放不下就长高，全文进 <title>
   *      供悬停 —— 学生看到的永远是整句话，不是「……」。实测：省略号是这类卡片的通病，
   *      而「少半句」比「字小一点」糟得多；
   *   ③ 坐标一律是 **720×420 舞台坐标**；所有基元在播放前 / 播放中调用都安全（只建 DOM，
   *      不碰时间轴），所以初始化顺序不会把动画搞坏。
   * ==================================================================== */

  /** 舞台坐标系（与 .k12-stage 的 viewBox 一致）。 */
  var STAGE_WIDTH = 720
  var STAGE_HEIGHT = 420

  /*
   * 舞台安全边距。
   *
   * ★★ 为什么要有「安全边距」这个概念（实测踩到）：步骤条（`.chip`）与字幕行是**外壳里的
   *   HTML**，排在 SVG 的下方；舞台本身在卡片里是等比缩放的（`preserveAspectRatio`）。
   *   内容一旦画到 420 的最下面几像素，就会被缩放的圆角裁掉，看着像「文字跑出框外」。
   *   所以舞台内容一律落在 [SAFE_MARGIN, STAGE_HEIGHT - SAFE_BOTTOM_MARGIN] 之内 ——
   *   自动布局的默认起止点就是这两条线，模板不用自己记。
   */
  var SAFE_MARGIN = 34
  var SAFE_BOTTOM_MARGIN = 30

  /**
   * 布局账本：自动布局（zone / row / stack）与各基元把它**最终**落在哪一行进这里。
   *
   * 用途只有一个：QA 与守卫能拿到「真实几何」而不是「生成器以为的几何」。
   * 单测 / 截图脚本读 `window.__K12_LAYOUT__` 就能做盒盒重叠检查 ——
   * 这正是当初「盒子悄悄长高压住邻居」看不见的原因（没有任何一处记录过真实尺寸）。
   */
  var layoutJournal = []
  try {
    window.__K12_LAYOUT__ = layoutJournal
  } catch (error) {
    /* 老环境没有 window：不影响渲染 */
  }

  /** 记一笔「某个盒子最后落在哪」（自动布局与基元共用）。 */
  function registerBox(group, kind) {
    if (group && group.k12Box) {
      try {
        layoutJournal.push({
          kind: kind || 'box',
          x: group.k12Box.x,
          y: group.k12Box.y,
          w: group.k12Box.w,
          h: group.k12Box.h
        })
      } catch (error) {
        /* 记账失败不该影响渲染 */
      }
    }
    return group
  }

  /** 读 <html> 上的属性（服务端注入；读不到按默认皮肤走，不算错误）。 */
  function dataAttribute(name) {
    try {
      var value = document.documentElement.getAttribute(name)
      return value ? String(value) : ''
    } catch (error) {
      return ''
    }
  }

  /** 当前学段（服务端打在 <html data-grade>；缺省 'default'）。 */
  var GRADE = dataAttribute('data-grade') || 'default'
  /** 当前皮肤：'illustrated'（小学）/ 'technical'（中学以上）。 */
  var SKIN = dataAttribute('data-skin') || 'technical'

  /*
   * 每种皮肤的动效预设 —— 模板**不要**自己写死时长与缓动，从 Sandbox.motion 取。
   *
   * illustrated：慢、带一点回弹（easeOutBack）、相位之间停得久 —— 小学要「看得清、跟得上」；
   * technical  ：快、克制（easeInOutQuad）、停顿短 —— 中学要「密度高、不拖沓」。
   * 这两种气质是产品要求（小学插画化 / 中学工程化），不是随手选的参数。
   *
   * ★ holdMs 是「这一相位演完之后、下一相位开始之前」的空档，也就是学生盯着这一屏
   *   正文（节点 + 字幕）的时间。它必须够读完一句话：一个相位的可见时间大约是
   *   duration + holdMs，两档都按「不少于 1.2 秒」定（插画档 1.6 秒上下，工程档贴着 1.2 秒）。
   *   原来 620 / 380 两档，工程档只有 0.84 秒，中学的相位正文（常带数字与标签）根本读不完，
   *   看着就像「一闪而过」。所以这里只加了 holdMs，duration 的分档（慢 / 快）一个字没动。
   *
   * ⚠️ preset-content/_meta/gen_animations.py 的 MOTION 是这两个数的副本（它用它估 duration_ms）。
   *   那边跟着改了，DURATION_RANGES 的区间也得一起看一眼。
   */
  var MOTION_PRESETS = {
    illustrated: { duration: 720, easing: 'easeOutBack', stagger: 140, holdMs: 880 },
    technical: { duration: 460, easing: 'easeInOutQuad', stagger: 90, holdMs: 740 }
  }

  var MOTION = (function () {
    var preset = MOTION_PRESETS[SKIN] || MOTION_PRESETS.technical
    return {
      duration: preset.duration,
      easing: preset.easing,
      stagger: preset.stagger,
      holdMs: preset.holdMs
    }
  })()

  function numberOf(value, fallback) {
    var number = typeof value === 'number' ? value : parseFloat(value)
    return isFinite(number) ? number : fallback
  }

  /** 读一个皮肤刻度（skins.css 里按 data-skin 定义；没有皮肤样式时用兜底值）。 */
  function scaleVariable(name, fallback) {
    try {
      var raw = window.getComputedStyle(document.documentElement).getPropertyValue(name)
      var number = parseFloat(raw)
      return isFinite(number) && number > 0 ? number : fallback
    } catch (error) {
      return fallback
    }
  }

  function isWideCharacter(character) {
    return character.charCodeAt(0) >= 0x2e80
  }

  /** 单字宽度（em，粗估）：中日韩与全角标点算一个字宽，西文按半宽 —— 只用于折行。 */
  function characterWidth(character) {
    if (character === ' ') return 0.3
    if (isWideCharacter(character)) return 1
    if (character >= '0' && character <= '9') return 0.56
    if (character >= 'A' && character <= 'Z') return 0.66
    return 0.54
  }

  function estimatedWidth(text, fontSize) {
    var total = 0
    for (var index = 0; index < text.length; index += 1) {
      total += characterWidth(text.charAt(index))
    }
    return total * fontSize
  }

  /** 折行单位：中文逐字可断，西文按单词（断在字母中间比折行难看得多）。 */
  function textUnits(text) {
    var units = []
    var buffer = ''
    for (var index = 0; index < text.length; index += 1) {
      var character = text.charAt(index)
      if (isWideCharacter(character) || character === ' ') {
        if (buffer) {
          units.push(buffer)
          buffer = ''
        }
        units.push(character)
      } else {
        buffer += character
      }
    }
    if (buffer) units.push(buffer)
    return units
  }

  /*
   * 中文避头标点：这些字**不能出现在行首**。
   *
   * ★ 实测踩到：气泡里「…重新算一遍坡度。」换行后，句号孤零零占了第二行 —— 排版上叫
   *   「孤字行 / 避头标点」，中文里读起来像少了一句。修法是折行时把这类标点**拉回上一行**
   *   （该行因此可能略超一点宽度，随后由 fitText 的统一收缩兜住）。
   *
   * ★ 省略号**故意不在这个表里**：它是「文字被截断」的视觉信号，而本运行时的纪律是
   *   **永不截断**（见本段开头的三条纪律）。连这个字面量都不出现，那条 grep 断言才能
   *   保持「零例外清单」—— 与 SVG 命名空间拆成两段拼是同一个理由。
   */
  var NO_LINE_START = '，。、；：！？）】》」』〕｝ヽヾゝゞ々ー・%—～'
  var NO_LINE_END = '（【《「『〔｛'

  function isNoLineStart(unit) {
    return unit.length === 1 && NO_LINE_START.indexOf(unit) >= 0
  }

  function isNoLineEnd(unit) {
    return unit.length === 1 && NO_LINE_END.indexOf(unit) >= 0
  }

  /** 按最大宽度折行。★ 不截断：超宽的西文单词只会撑破行，随后由字号收缩兜住。 */
  function wrapText(text, maxWidth, fontSize) {
    var units = textUnits(String(text == null ? '' : text))
    var lines = []
    var current = ''
    var index = 0
    while (index < units.length) {
      var unit = units[index]
      if (unit === ' ' && !current) {
        index += 1
        continue
      }
      var tooWide = current !== '' && estimatedWidth(current + unit, fontSize) > maxWidth
      // 避头标点（。，、）：不换行，跟上一行绑住（那一行宁可略宽一点）
      // 避尾标点（「（《）：它不该落在行尾，所以让它自己起一行
      var breakBefore = current !== '' && (isNoLineEnd(unit) || (tooWide && !isNoLineStart(unit)))
      if (breakBefore) {
        lines.push(current.replace(/\s+$/, ''))
        current = ''
        continue // 同一个 unit 回到循环里，作为新行的开头
      }
      current += unit
      index += 1
    }
    if (current) lines.push(current.replace(/\s+$/, ''))
    return lines.length ? lines : ['']
  }

  /** 折行 + 按「行数上限 / 宽度上限」收缩字号（下限 minFontSize）。 */
  function fitText(text, maxWidth, fontSize, minFontSize, maxLines) {
    var size = fontSize
    var lines = wrapText(text, maxWidth, size)
    var guard = 0
    while (guard < 12 && size > minFontSize) {
      var widest = 0
      for (var index = 0; index < lines.length; index += 1) {
        widest = Math.max(widest, estimatedWidth(lines[index], size))
      }
      if (lines.length <= maxLines && widest <= maxWidth) break
      size = Math.max(minFontSize, Math.round(size * 0.92 * 10) / 10)
      lines = wrapText(text, maxWidth, size)
      guard += 1
    }
    return { lines: lines, fontSize: size }
  }

  function measuredWidth(element) {
    try {
      var box = element.getBBox()
      return isFinite(box.width) ? box.width : 0
    } catch (error) {
      return 0
    }
  }

  /**
   * 画一段居中文字（块中心 = x,y；`anchor:'start'` 时 x 是左边缘）。
   *
   * ★ 两段式：先按粗估折行渲染，**再实测一次**（getBBox）—— 字体与估算总有偏差，
   *   实测超宽就按比例缩字号重排。全程只缩字号、只折行，**从不截断**。
   *   元素还没进渲染树时 getBBox 量不到（返回 0），此时信粗估，不影响渲染。
   */
  function paintText(target, text, options) {
    var anchor = options.anchor === 'start' ? 'start' : 'middle'
    var fontSize = numberOf(options.fontSize, 14)
    var minFontSize = numberOf(options.minFontSize, 10.5)
    var element = null
    var attempts = 0
    while (attempts < 5) {
      var fitted = fitText(text, options.maxWidth, fontSize, minFontSize, numberOf(options.maxLines, 4))
      if (element && element.parentNode) element.parentNode.removeChild(element)
      element = Sandbox.svgEl('text')
      element.setAttribute('class', options.className)
      element.setAttribute('text-anchor', anchor)
      element.setAttribute('dominant-baseline', 'central')
      element.setAttribute('x', String(options.x))
      element.setAttribute('y', String(options.y))
      element.style.fontSize = fitted.fontSize + 'px'
      var lineHeight = fitted.fontSize * 1.34
      var top = options.y - ((fitted.lines.length - 1) * lineHeight) / 2
      for (var index = 0; index < fitted.lines.length; index += 1) {
        var span = Sandbox.svgEl('tspan')
        span.setAttribute('x', String(options.x))
        if (index === 0) span.setAttribute('y', String(top))
        else span.setAttribute('dy', String(lineHeight))
        span.textContent = fitted.lines[index]
        element.appendChild(span)
      }
      target.appendChild(element)
      var measured = measuredWidth(element)
      if (measured <= 0 || measured <= options.maxWidth || fitted.fontSize <= minFontSize) break
      fontSize = Math.max(
        minFontSize,
        Math.round(((fitted.fontSize * options.maxWidth) / measured) * 10) / 10
      )
      attempts += 1
    }
    return element
  }

  /** 全文写进 <title>（悬停可见）—— 「缩字号 + 换行」之后仍可能被视觉裁掉的兜底。 */
  function attachTooltip(group, text) {
    var value = text == null ? '' : String(text)
    if (!value) return group
    var title = Sandbox.svgEl('title')
    title.textContent = value
    group.insertBefore(title, group.firstChild)
    return group
  }

  function svgLine(className, x1, y1, x2, y2) {
    var element = Sandbox.svgEl('line')
    element.setAttribute('class', className)
    element.setAttribute('x1', String(x1))
    element.setAttribute('y1', String(y1))
    element.setAttribute('x2', String(x2))
    element.setAttribute('y2', String(y2))
    return element
  }

  /*
   * 箭头（默认朝 +x；rotation 是角度）。用路径而不是 marker：marker 的配色没法跟着 CSS 类走。
   *
   * length / halfWidth 由调用方按「线宽」给：坐标轴是 1.7 的细线，连接线是 --k12-stroke，
   * 粗管道是 9。一套尺寸套在所有线宽上，细线上显笨重、粗管道上又被吞掉，所以分档。
   * 默认值是细线那一档；轴的箭头更钝一点（刻度感），链接的箭头更尖（指向感）。
   *
   * 三角形背后那条边往尖端收了 0.16 倍（不是一根平直的竖边）：箭头的两腰因此更长，
   * 同样长度下看着更锐，也不再是「一个等腰三角形贴在线上」那种示意图形。
   */
  function arrowHead(className, x, y, rotation, length, halfWidth) {
    var size = numberOf(length, 11)
    var half = numberOf(halfWidth, 4.2)
    var backX = -size * 0.84
    var element = Sandbox.svgEl('path')
    element.setAttribute('class', className)
    element.setAttribute(
      'd',
      'M 0 0 L ' + -size + ' ' + -half + ' L ' + backX + ' 0 L ' + -size + ' ' + half + ' Z'
    )
    element.setAttribute('transform', 'translate(' + x + ' ' + y + ') rotate(' + rotation + ')')
    return element
  }

  /* ---------------------------------------------------------------- *
   * 舞台：一块 720×420 的 SVG，两层（背景 / 前景）
   * ---------------------------------------------------------------- */

  var stageState = null

  function buildStage() {
    var host = document.querySelector('.anim-canvas')
    if (!host) {
      // 模板没写 .anim-canvas（老模板可能只有 svg）：补一个，别让基元无处落脚
      host = document.createElement('div')
      host.setAttribute('class', 'anim-canvas')
      var master = document.getElementById('stage') || document.body
      if (master) master.appendChild(host)
    }
    var svg = Sandbox.svgEl('svg')
    svg.setAttribute('class', 'k12-stage')
    svg.setAttribute('viewBox', '0 0 ' + STAGE_WIDTH + ' ' + STAGE_HEIGHT)
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet')
    svg.setAttribute('width', '100%')
    svg.setAttribute('height', '100%')
    svg.setAttribute('role', 'img')

    var background = Sandbox.svgEl('g')
    background.setAttribute('class', 'k12-layer k12-layer-bg')
    var plate = Sandbox.svgEl('rect')
    plate.setAttribute('class', 'k12-stage-bg')
    plate.setAttribute('x', '0')
    plate.setAttribute('y', '0')
    plate.setAttribute('width', String(STAGE_WIDTH))
    plate.setAttribute('height', String(STAGE_HEIGHT))
    plate.setAttribute('rx', '12')
    background.appendChild(plate)

    var foreground = Sandbox.svgEl('g')
    foreground.setAttribute('class', 'k12-layer k12-layer-fg')

    svg.appendChild(background)
    svg.appendChild(foreground)
    host.appendChild(svg)
    return { svg: svg, bg: background, fg: foreground }
  }

  /** 取（必要时建）舞台的两层。重复调用不会重复建 —— 幂等。 */
  function stageLayers() {
    if (!stageState || !stageState.svg || !stageState.svg.parentNode) stageState = buildStage()
    return stageState
  }

  function stage() {
    var layers = stageLayers()
    return { svg: layers.svg, width: STAGE_WIDTH, height: STAGE_HEIGHT }
  }

  function foregroundLayer() {
    return stageLayers().fg
  }

  function backgroundLayer() {
    return stageLayers().bg
  }

  /* ---------------------------------------------------------------- *
   * 背景层：网格 / 坐标轴
   * ---------------------------------------------------------------- */

  function grid(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 34)
    var y = numberOf(opts.y, 30)
    var width = Math.max(40, numberOf(opts.w, STAGE_WIDTH - x * 2))
    var height = Math.max(40, numberOf(opts.h, STAGE_HEIGHT - y * 2))
    var columns = Math.max(1, Math.round(numberOf(opts.cols, 8)))
    var rows = Math.max(1, Math.round(numberOf(opts.rows, 5)))
    var group = Sandbox.svgEl('g')
    group.setAttribute('class', 'k12-grid')
    var index
    // 只画内部格线：最外那两条与下面的 k12-grid-frame 完全重合，画两遍只是把一条线描粗
    // （还让「边框」有了两种线端）。网格因此是「框 + 里面的格子」，与刻度纸的样子一致。
    for (index = 1; index < columns; index += 1) {
      var columnX = x + (width * index) / columns
      group.appendChild(svgLine('k12-grid-line', columnX, y, columnX, y + height))
    }
    for (index = 1; index < rows; index += 1) {
      var rowY = y + (height * index) / rows
      group.appendChild(svgLine('k12-grid-line', x, rowY, x + width, rowY))
    }
    var frame = Sandbox.svgEl('rect')
    frame.setAttribute('class', 'k12-grid-frame')
    frame.setAttribute('x', String(x))
    frame.setAttribute('y', String(y))
    frame.setAttribute('width', String(width))
    frame.setAttribute('height', String(height))
    frame.setAttribute('rx', '6')
    group.appendChild(frame)
    backgroundLayer().appendChild(group)
    return group
  }

  function axis(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 70)
    var y = numberOf(opts.y, 44)
    var width = Math.max(60, numberOf(opts.w, STAGE_WIDTH - x - 70))
    var height = Math.max(60, numberOf(opts.h, STAGE_HEIGHT - y - 70))
    var labelSize = scaleVariable('--k12-fs-axis', 12.5)
    var group = Sandbox.svgEl('g')
    group.setAttribute('class', 'k12-axis')
    var bottom = y + height
    var right = x + width
    group.appendChild(svgLine('k12-axis-line', x, bottom, right, bottom))
    group.appendChild(svgLine('k12-axis-line', x, bottom, x, y))
    // 轴箭头比连接线的钝一点、也长一点：轴是「量尺」的一端，箭头太尖会像在指方向
    group.appendChild(arrowHead('k12-axis-arrow', right, bottom, 0, 13, 5.2))
    group.appendChild(arrowHead('k12-axis-arrow', x, y, -90, 13, 5.2))
    var index
    // 刻度长 6（原来 5）：与 1.7 的轴线摆在一起读得出「有刻度」，又不至于像一段网格线
    for (index = 1; index < 5; index += 1) {
      var tickX = x + (width * index) / 5
      group.appendChild(svgLine('k12-axis-tick', tickX, bottom, tickX, bottom + 6))
    }
    for (index = 1; index < 4; index += 1) {
      var tickY = bottom - (height * index) / 4
      group.appendChild(svgLine('k12-axis-tick', x - 6, tickY, x, tickY))
    }
    if (opts.xLabel) {
      paintText(group, String(opts.xLabel), {
        className: 'k12-axis-label',
        x: x + width / 2,
        y: bottom + 26,
        maxWidth: width,
        fontSize: labelSize,
        minFontSize: 9,
        maxLines: 1
      })
    }
    if (opts.yLabel) {
      paintText(group, String(opts.yLabel), {
        className: 'k12-axis-label',
        x: x,
        y: y - 16,
        maxWidth: width,
        fontSize: labelSize,
        minFontSize: 9,
        maxLines: 1
      })
    }
    // 画布区域（坐标轴围出来的那块）：调用方照着它把数据映射进去
    group.plot = { x: x, y: y, w: width, h: height, originX: x, originY: bottom }
    backgroundLayer().appendChild(group)
    return group
  }

  /* ---------------------------------------------------------------- *
   * 前景层基元
   * ---------------------------------------------------------------- */

  function toneOf(tone) {
    var value = String(tone == null ? '' : tone)
    return value === 'accent' || value === 'muted' || value === 'warn' ? value : 'base'
  }

  /*
   * 一个盒子里文字**真实需要**的高度 —— 与 ``node()`` 走**同一套** ``fitText``。
   *
   * ★★ 为什么必须抽成一个函数（实测踩到的根因）：自动布局要在**建盒子之前**知道
   *   「这一行的上限高度是多少」。若布局自己另算一套（比如「一行 24 字」这种拍脑袋估法），
   *   它给的高度与 ``node()`` 真实需要的高度就会差一截 —— 差额让盒子**长高**，
   *   长出来的那半截压住下一行。所以规划与落地必须是同一个函数。
   */
  function nodeMetrics(label, sub, width) {
    var pad = scaleVariable('--k12-pad', 14)
    var labelSize = scaleVariable('--k12-fs-node', 17)
    var subSize = scaleVariable('--k12-fs-node-sub', 12.5)
    var innerWidth = Math.max(24, width - pad * 2)
    var labelText = label == null ? '' : String(label)
    var subText = sub == null ? '' : String(sub)
    var labelFit = labelText ? fitText(labelText, innerWidth, labelSize, 11, 4) : null
    var labelHeight = labelFit ? labelFit.lines.length * labelFit.fontSize * 1.34 : 0
    var subFit = subText ? fitText(subText, innerWidth, subSize, 10, 3) : null
    var subHeight = subFit ? subFit.lines.length * subFit.fontSize * 1.34 : 0
    var midGap = subFit ? Math.max(2, pad * 0.3) : 0
    return {
      pad: pad,
      labelHeight: labelHeight,
      subHeight: subHeight,
      midGap: midGap,
      needed: labelHeight + midGap + subHeight + pad * 2
    }
  }

  /** 节点：圆角矩形 + 居中文字（+ 可选副标题）。**文字永不截断**。 */
  function node(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 0)
    var y = numberOf(opts.y, 0)
    var width = Math.max(48, numberOf(opts.w, 180))
    var height = Math.max(34, numberOf(opts.h, 78))
    var declaredHeight = height
    var metrics = nodeMetrics(opts.label, opts.sub, width)
    var pad = metrics.pad
    var label = opts.label == null ? '' : String(opts.label)
    var sub = opts.sub == null ? '' : String(opts.sub)

    var group = Sandbox.svgEl('g')
    group.setAttribute(
      'class',
      'k12-node k12-node--' + toneOf(opts.tone) + (opts.focus ? ' k12-node--focus' : '')
    )
    var body = Sandbox.svgEl('rect')
    body.setAttribute('class', 'k12-node-body')
    body.setAttribute('x', String(x))
    body.setAttribute('y', String(y))
    body.setAttribute('width', String(width))
    body.setAttribute('height', String(height))
    body.setAttribute('rx', '12')
    group.appendChild(body)

    var labelSize = scaleVariable('--k12-fs-node', 17)
    var subSize = scaleVariable('--k12-fs-node-sub', 12.5)
    var innerWidth = Math.max(24, width - pad * 2)
    var labelHeight = metrics.labelHeight
    var subHeight = metrics.subHeight
    var gap = metrics.midGap
    var needed = metrics.needed

    // ★ 装不下就**长高**（而不是截断文字）。
    //   ★★ 但长高必须**被调用方看见**：``k12Grow`` 把「要了多少 / 实际多少」记在组上，
    //   自动布局（Sandbox.row / zone）据此把**整条带**一起加高，而不是让这一个盒子
    //   悄悄压住下面的邻居 —— 「长高但不告诉别人」正是实测踩到的那类重叠。
    if (needed > height) {
      height = needed
      body.setAttribute('height', String(height))
    }
    // ★ 文字块的高度只用「真的会画出来的那几行」算：
    //   metrics.midGap 是主副两行之间的间隔，只有两行都在时它才该进这个总高。
    //   只有副标题（没有主标题）时它仍然占着位置，等于把副标题往下推半个 gap，
    //   看着就不是居中（盒子被内容撑高之后尤其明显）。这里只改居中用的算式，
    //   nodeMetrics 一个数都没动（生成器侧照同一套预留尺寸）。
    var textGap = label && sub ? gap : 0
    var top = y + height / 2 - (labelHeight + textGap + subHeight) / 2
    var labelElement = null
    if (label) {
      labelElement = paintText(group, label, {
        className: 'k12-node-label',
        x: x + width / 2,
        y: top + labelHeight / 2,
        maxWidth: innerWidth,
        fontSize: labelSize,
        minFontSize: 11,
        maxLines: 4
      })
    }
    var subElement = null
    if (sub) {
      subElement = paintText(group, sub, {
        className: 'k12-node-sub',
        x: x + width / 2,
        y: top + labelHeight + textGap + subHeight / 2,
        maxWidth: innerWidth,
        fontSize: subSize,
        minFontSize: 10,
        maxLines: 3
      })
    }
    attachTooltip(group, sub ? label + ' · ' + sub : label)
    foregroundLayer().appendChild(group)

    // 额外句柄（非冻结）：给 link() 定位用，也方便模板自己动某个部件
    group.body = body
    group.labelElement = labelElement
    group.subElement = subElement
    group.k12Box = { x: x, y: y, w: width, h: height }
    group.k12Grow = { declared: declaredHeight, actual: height, grew: height > declaredHeight + 0.01 }
    registerBox(group, 'node')
    return group
  }

  /** 人物：插画皮肤的当家角色（工程皮肤里变成一个克制的示意体，同一份代码）。 */
  function actor(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 0)
    var y = numberOf(opts.y, 0) // 脚底（站在 y 这条线上）
    var pose = String(opts.pose == null ? '' : opts.pose)
    if (pose !== 'point' && pose !== 'carry' && pose !== 'walk') pose = 'stand'
    var scale = Math.max(0.4, numberOf(opts.scale, 1))
    var label = opts.label == null ? '' : String(opts.label)

    var group = Sandbox.svgEl('g')
    group.setAttribute('class', 'k12-actor k12-actor--' + pose)
    group.setAttribute('transform', 'translate(' + x + ' ' + y + ') scale(' + scale + ')')

    function limb(x1, y1, x2, y2) {
      return svgLine('k12-actor-limb', x1, y1, x2, y2)
    }

    // 腿
    if (pose === 'walk') {
      group.appendChild(limb(-4, -32, -17, 0))
      group.appendChild(limb(4, -32, 16, 0))
    } else if (pose === 'stand') {
      group.appendChild(limb(-7, -32, -8, 0))
      group.appendChild(limb(7, -32, 8, 0))
    } else {
      group.appendChild(limb(-6, -32, -7, 0))
      group.appendChild(limb(6, -32, 7, 0))
    }
    // 身体
    var torso = Sandbox.svgEl('rect')
    torso.setAttribute('class', 'k12-actor-body')
    torso.setAttribute('x', '-15')
    torso.setAttribute('y', '-64')
    torso.setAttribute('width', '30')
    torso.setAttribute('height', '34')
    torso.setAttribute('rx', '10')
    group.appendChild(torso)
    // 头（插画皮肤是圆的，工程皮肤是方的 —— 由 CSS 的 rx 决定）
    var head = Sandbox.svgEl('rect')
    head.setAttribute('class', 'k12-actor-head')
    head.setAttribute('x', '-13')
    head.setAttribute('y', '-92')
    head.setAttribute('width', '26')
    head.setAttribute('height', '26')
    head.setAttribute('rx', '13')
    group.appendChild(head)
    /*
     * 脸：只有插画皮肤画（工程皮肤是克制的示意体，点与弧会把它变成卡通，不该出现）。
     *
     * ★ 一根线也不新增：眼睛与笑都用既有的 k12-actor-limb。那条规则在 skins.css 里
     *   已经是「圆头收笔」，于是一段极短的线就落成一个圆点（眼睛），一条下凹的二次曲线
     *   就是笑。颜色 / 线宽 / 收笔形状全部由 skins.css 说了算，这里只给坐标。
     *   （顺带说明为什么只画在插画皮肤：工程皮肤那条规则把收笔改成方头，
     *   同样的短段会变成小方块，脸就散了。）
     *
     * ★ 位置写进元素自己的几何属性（x1 / y1 / d），脸上不套任何 transform：
     *   与人物那套「位置与动画分两层」是同一个道理（见 layout() 里 seat / pivot 的注释）。
     *   anime 的 scale / translate 写的是 style.transform，会整段盖掉元素自己的 transform
     *   属性；把坐标留在属性上，将来谁给眼睛加个眨眼的缩放都不会把它弹回原点。
     */
    if (SKIN === 'illustrated') {
      // 眼睛：头从 -92 到 -66，中点是 -79，双眼落在中点稍上一点
      group.appendChild(limb(-4.3, -83.4, -4.3, -83.2))
      group.appendChild(limb(4.3, -83.4, 4.3, -83.2))
      // 笑：一条下凹的弧（控制点拉在两端连线的下方），比几段折线拼出来的自然
      var smile = Sandbox.svgEl('path')
      smile.setAttribute('class', 'k12-actor-limb')
      smile.setAttribute('d', 'M -5.2 -75 Q 0 -71 5.2 -75')
      group.appendChild(smile)
    }
    // 手
    if (pose === 'point') {
      group.appendChild(limb(12, -58, 38, -66))
      group.appendChild(limb(-12, -58, -20, -36))
    } else if (pose === 'carry') {
      group.appendChild(limb(10, -58, 20, -47))
      group.appendChild(limb(-10, -58, -20, -47))
      var prop = Sandbox.svgEl('rect')
      prop.setAttribute('class', 'k12-actor-prop')
      prop.setAttribute('x', '-17')
      prop.setAttribute('y', '-54')
      prop.setAttribute('width', '34')
      prop.setAttribute('height', '20')
      prop.setAttribute('rx', '4')
      group.appendChild(prop)
    } else if (pose === 'walk') {
      group.appendChild(limb(-10, -58, -25, -44))
      group.appendChild(limb(10, -58, 25, -46))
    } else {
      group.appendChild(limb(-13, -58, -17, -34))
      group.appendChild(limb(13, -58, 17, -34))
    }
    if (label) {
      paintText(group, label, {
        className: 'k12-actor-label',
        x: 0,
        y: 24,
        maxWidth: 160,
        fontSize: scaleVariable('--k12-fs-actor', 12.5),
        minFontSize: 9,
        maxLines: 2
      })
    }
    attachTooltip(group, label)
    foregroundLayer().appendChild(group)
    /*
     * ★ 真实占位（比「一个 40 宽的盒子」诚实）：
     *   · 头顶到脚底 96 个单位；
     *   · 脚下那行名字**也算进去** —— 实测踩到：只算身体时，人物的名字正好压在
     *     底部的读数框上（截图里两串字叠成一团），而几何检查看不见它。
     */
    var labelWidth = 40
    if (label) {
      labelWidth = Math.max(
        40,
        Math.min(160, estimatedWidth(label, scaleVariable('--k12-fs-actor', 12.5)))
      )
    }
    var labelRoom = label ? 30 : 0
    group.k12Box = {
      x: x - (labelWidth / 2) * scale,
      y: y - 96 * scale,
      w: labelWidth * scale,
      h: (96 + labelRoom) * scale
    }
    /** 脚底的**锚点**（人物站在哪条线上）—— 守卫要查「人物站在讲得通的地方」就查它。 */
    group.k12Anchor = { x: x, y: y }
    registerBox(group, 'actor')
    return group
  }

  /**
   * 气泡**真实需要**的尺寸（与 ``bubble()`` 同一套算式 —— 自动布局要在建框之前知道它）。
   * ``needed`` 把尾巴那 14px 也算进去：尾巴也是要占地面的（否则它会插进下一行的盒子）。
   */
  function bubbleMetrics(text, maxWidth, tail) {
    var pad = scaleVariable('--k12-pad', 14)
    var fontSize = scaleVariable('--k12-fs-bubble', 15)
    var width = Math.max(120, numberOf(maxWidth, 260))
    var innerWidth = Math.max(60, width - pad * 2)
    var fitted = fitText(text == null ? '' : String(text), innerWidth, fontSize, 10.5, 6)
    var widest = 0
    for (var index = 0; index < fitted.lines.length; index += 1) {
      widest = Math.max(widest, estimatedWidth(fitted.lines[index], fitted.fontSize))
    }
    var boxWidth = Math.max(96, Math.min(width, Math.ceil(widest) + pad * 2))
    var lineHeight = fitted.fontSize * 1.34
    var boxHeight = Math.max(pad * 2 + lineHeight, fitted.lines.length * lineHeight + pad * 2)
    var tailRoom = tail === 'none' ? 0 : 14
    return {
      pad: pad,
      width: boxWidth,
      height: boxHeight,
      tail: tailRoom,
      needed: boxHeight + tailRoom
    }
  }

  /** 气泡：圆角说话框 + 小尾巴。text 永不截断（折行 + 缩字号 + 框变高）。 */
  function bubble(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 0)
    var y = numberOf(opts.y, 0)
    var text = opts.text == null ? '' : String(opts.text)
    var who = String(opts.who == null ? '' : opts.who)
    var tail = opts.tail == null ? 'left' : String(opts.tail)
    var sized = bubbleMetrics(text, numberOf(opts.w, 260), tail)
    var pad = sized.pad
    var boxWidth = sized.width
    var boxHeight = sized.height

    var group = Sandbox.svgEl('g')
    group.setAttribute('class', 'k12-bubble' + (who ? ' k12-bubble--' + who : ''))
    var body = Sandbox.svgEl('rect')
    body.setAttribute('class', 'k12-bubble-body')
    body.setAttribute('x', String(x))
    body.setAttribute('y', String(y))
    body.setAttribute('width', String(boxWidth))
    body.setAttribute('height', String(boxHeight))
    body.setAttribute('rx', '14')
    group.appendChild(body)

    if (tail !== 'none') {
      /*
       * 尾巴几何。
       *
       * ★ 基准边（贴在框底的那条）要让开圆角的「弧段」再起：让开的距离跟着面板圆角走
       *   （插画皮肤 18，工程皮肤 6，见 skins.css 的 --k12-radius-panel）。原来写死 14，
       *   而插画皮肤的圆角是 18，于是这条基准边正落在圆弧上，缝合线一横抹过去就把框底
       *   那圈描边擦出一道缺口（整条框底看起来断了一截）。取 max(14, 圆角 + 2)，两个皮肤都成立。
       *
       * ★ 尾巴的「占位」一个数都没变：尖端仍在框底下方 14（与 bubbleMetrics 的 tailRoom 同源，
       *   生成器侧照它预留高度）。变的只是这道三角的形状：基准边收到 18，离框角远的那条长边
       *   走一段浅弧（手绘感，不再是尺子画的直角三角形），基准边整体抬进框里 0.4，
       *   好让自己那圈描边被缝合线盖干净（原来两端各露 1.5 的一小截双描边）。
       */
      var bottomY = y + boxHeight
      var panelRadius = scaleVariable('--k12-radius-panel', 14)
      var baseInset = Math.max(14, panelRadius + 2)
      var baseWidth = 18
      // 靠近框角那条底边叫 nearX，离尖端远的那条叫 farX
      var nearX = tail === 'right' ? x + boxWidth - baseInset - baseWidth : x + baseInset
      var farX = nearX + baseWidth
      var tipX = tail === 'right' ? x + boxWidth - 5 : x + 5
      var baseY = bottomY - 0.4
      var tipY = bottomY + 14
      // 长边（farX 到尖端）弯一点：控制点朝尖端一侧拉，弧往外鼓，看着是「吹出来」而不是「切下来」
      var lean = Math.abs(farX - tipX)
      var controlX = tipX + (tipX > farX ? -1 : 1) * lean * 0.3
      var path = Sandbox.svgEl('path')
      path.setAttribute('class', 'k12-bubble-tail')
      path.setAttribute(
        'd',
        'M ' + nearX + ' ' + baseY + ' L ' + farX + ' ' + baseY +
          ' Q ' + controlX + ' ' + (baseY + (tipY - baseY) * 0.5) + ' ' + tipX + ' ' + tipY + ' Z'
      )
      group.appendChild(path)
      // 缝合线：把尾巴与框共享的那条边盖掉（否则框底会横穿尾巴）。
      // 一直盖到基准边的两端（只各留 0.5，免得把尾巴外沿的描边也抹掉）。
      group.appendChild(svgLine('k12-bubble-tail-seam', nearX + 0.5, bottomY, farX - 0.5, bottomY))
    }
    /*
     * 文字在框里居中（框高本身就是「行数 x 行高 + 上下内边距」，所以不用再算边距）。
     *
     * 唯一的光学补偿：带尾巴时，框底下面还多出一截 14 高的三角，整块形状的重心偏下，
     * 文字按几何居中看着就像「贴着下沿」。所以有尾巴时把正文整体抬 1.5（不涉及字号与折行，
     * 折行与测量一个数都没动）。
     */
    paintText(group, text, {
      className: 'k12-bubble-text',
      x: x + boxWidth / 2,
      y: y + boxHeight / 2 - (tail === 'none' ? 0 : 1.5),
      maxWidth: Math.max(60, boxWidth - pad * 2),
      fontSize: scaleVariable('--k12-fs-bubble', 15),
      minFontSize: 10.5,
      maxLines: 6
    })
    attachTooltip(group, text)
    foregroundLayer().appendChild(group)
    group.k12Box = { x: x, y: y, w: boxWidth, h: boxHeight + sized.tail }
    group.k12Grow = { declared: boxHeight, actual: boxHeight, grew: false }
    registerBox(group, 'bubble')
    return group
  }

  /**
   * 把一个参数解析成「矩形」。
   *
   * 接受四种形态：``node()``/``readout()`` 等基元返回的 ``<g>``（读它的 ``k12Box``）、
   * ``{x,y,w,h}``、``{x,y}``（点）、以及**坐标对 ``[x, y]``**。
   *
   * ★★ 实测缺陷（用户看到的「路没了、小人悬在空中」）：清单里的 ``rails`` 按文档写成
   *   ``from: [36, 225]`` 这样的**坐标对**，而这里只认对象 —— 数组取 ``.x`` 是
   *   ``undefined``，于是 ``boxOf`` 返回 null、``link()`` 给了一个**空组**，
   *   连线条都没画，而且**不报错**。声明式布局里所有 ``[x, y]`` 一路都是静默丢失。
   *   「参数形式不认」必须当场兜住，不能变成「画面少了一半还没有人知道」。
   */
  function boxOf(value) {
    if (!value) return null
    if (value.k12Box) return value.k12Box
    if (Object.prototype.toString.call(value) === '[object Array]') {
      var pairX = numberOf(value[0], null)
      var pairY = numberOf(value[1], null)
      if (pairX === null || pairY === null) return null
      return { x: pairX, y: pairY, w: 0, h: 0 }
    }
    var x = numberOf(value.x, null)
    var y = numberOf(value.y, null)
    if (x === null || y === null) return null
    return { x: x, y: y, w: Math.max(0, numberOf(value.w, 0)), h: Math.max(0, numberOf(value.h, 0)) }
  }

  /** 矩形边界上、朝着 towards 那一点的位置（连线用：从盒子的边出发，而不是从中心）。 */
  function edgePoint(box, towards) {
    var centerX = box.x + box.w / 2
    var centerY = box.y + box.h / 2
    if (!box.w || !box.h) return { x: box.x, y: box.y }
    var deltaX = towards.x - centerX
    var deltaY = towards.y - centerY
    if (deltaX === 0 && deltaY === 0) return { x: centerX, y: centerY }
    var scaleX = deltaX === 0 ? Infinity : box.w / 2 / Math.abs(deltaX)
    var scaleY = deltaY === 0 ? Infinity : box.h / 2 / Math.abs(deltaY)
    var factor = Math.min(scaleX, scaleY)
    return { x: centerX + deltaX * factor, y: centerY + deltaY * factor }
  }

  /** 连接线：a / b 可以是 node()/readout() 的返回值，也可以是 {x,y,w,h} 或 {x,y}。 */
  function link(from, to, options) {
    var opts = options || {}
    var group = Sandbox.svgEl('g')
    var boxA = boxOf(from)
    var boxB = boxOf(to)
    // 参数不对时给一个空组：宁可少一条线，也别打断整段动画。
    // ★ 但**留下痕迹** —— 早先这里是纯静默返回，于是「清单里的 [x,y] 一路没人认」
    //   表现为画面少了一条路、控制台一个字都没有，查了很久（见 boxOf 的注释）。
    //   现在记进 window.__K12_LAYOUT__.droppedLinks，体检脚本一眼就能看见。
    if (!boxA || !boxB) {
      try {
        var audit = window.__K12_LAYOUT__
        if (audit) {
          audit.droppedLinks = audit.droppedLinks || []
          audit.droppedLinks.push({ from: from, to: to })
        }
      } catch (error) {
        /* 体检信息拿不到就算了，绝不能因此打断动画 */
      }
      return group
    }
    var centerA = { x: boxA.x + boxA.w / 2, y: boxA.y + boxA.h / 2 }
    var centerB = { x: boxB.x + boxB.w / 2, y: boxB.y + boxB.h / 2 }
    var start = edgePoint(boxA, centerB)
    var end = edgePoint(boxB, centerA)
    var style = String(opts.style == null ? '' : opts.style)
    if (style !== 'dashed' && style !== 'pipe') style = 'solid'
    group.setAttribute('class', 'k12-link k12-link--' + style)
    if (style === 'pipe') {
      group.appendChild(svgLine('k12-link-pipe', start.x, start.y, end.x, end.y))
    }
    var angle = Math.atan2(end.y - start.y, end.x - start.x)
    var directed = !!opts.directed
    // 箭头的尺寸跟着线宽分档（见 arrowHead 的说明）：粗管道那一档大，细实线与虚线那一档小
    var headSize = style === 'pipe' ? 14 : style === 'dashed' ? 10 : 11
    var headHalf = style === 'pipe' ? 5.4 : style === 'dashed' ? 3.8 : 4.2
    // 线在箭头的「尾沿」之前收住（原来的 11 是按 13 长的箭头调的；箭头一变小，
    // 那个缺口就会露到箭头外面，看成一截没接上的短线）
    var stop
    if (directed) {
      var gap = headSize - 1.8
      stop = { x: end.x - Math.cos(angle) * gap, y: end.y - Math.sin(angle) * gap }
    } else {
      stop = end
    }
    group.appendChild(svgLine('k12-link-line', start.x, start.y, stop.x, stop.y))
    if (directed) {
      group.appendChild(
        arrowHead('k12-link-arrow', end.x, end.y, (angle * 180) / Math.PI, headSize, headHalf)
      )
    }
    var label = opts.label == null ? '' : String(opts.label)
    if (label) {
      var midX = (start.x + stop.x) / 2
      var midY = (start.y + stop.y) / 2
      var labelWidth = Math.max(80, numberOf(opts.labelWidth, 190))
      var fontSize = scaleVariable('--k12-fs-link', 13)
      var fitted = fitText(label, labelWidth, fontSize, 9.5, 3)
      var widest = 0
      for (var index = 0; index < fitted.lines.length; index += 1) {
        widest = Math.max(widest, estimatedWidth(fitted.lines[index], fitted.fontSize))
      }
      var backWidth = Math.max(28, Math.ceil(widest) + 14)
      var backHeight = fitted.lines.length * fitted.fontSize * 1.34 + 8
      var back = Sandbox.svgEl('rect')
      back.setAttribute('class', 'k12-link-label-bg')
      back.setAttribute('x', String(midX - backWidth / 2))
      back.setAttribute('y', String(midY - backHeight / 2))
      back.setAttribute('width', String(backWidth))
      back.setAttribute('height', String(backHeight))
      back.setAttribute('rx', '6')
      group.appendChild(back)
      paintText(group, label, {
        className: 'k12-link-label',
        x: midX,
        y: midY,
        maxWidth: labelWidth,
        fontSize: fontSize,
        minFontSize: 9.5,
        maxLines: 3
      })
    }
    foregroundLayer().appendChild(group)
    group.label = label
    return group
  }

  /*
   * 读数框**真实需要**的高度：标签一行 + 数值一行 + 上下内边距。
   *
   * ★★ 实测踩到（用户投诉里的「右下角读数与步骤计数撞在一起，两个都看不清」）：
   *   读数内部是「标签在上、数值在下」两段，但高度写死 58 时，27px 的数值会把
   *   标签整个盖住（两串字叠在同一片像素上）。所以：
   *     ① 高度按内容算（这个函数），不够就长高；
   *     ② 数值的**顶部**必须在标签的**底部**之下（见下面的 valueTop）。
   *   与 ``node`` 一样，长高会记进 ``k12Grow``，自动布局据此把整条带一起让位。
   */
  function readoutMetrics(label, width) {
    var pad = scaleVariable('--k12-pad', 14)
    var labelSize = scaleVariable('--k12-fs-readout-label', 12.5)
    var valueSize = scaleVariable('--k12-fs-readout-value', 24)
    var innerWidth = Math.max(40, width - pad * 2)
    var text = label == null ? '' : String(label)
    var fit = text ? fitText(text, innerWidth, labelSize, 9.5, 2) : null
    var labelHeight = fit ? fit.lines.length * fit.fontSize * 1.34 : 0
    var valueHeight = valueSize * 1.34
    var midGap = labelHeight ? 6 : 0
    return {
      pad: pad,
      labelHeight: labelHeight,
      valueHeight: valueHeight,
      midGap: midGap,
      needed: pad + labelHeight + midGap + valueHeight + pad
    }
  }

  /*
   * central 基线大约比字面的视觉中心低多少（em）。
   *
   * 本文件的文字都按 dominant-baseline: central 画（对中文是最准的一档：字面上下对称）。
   * 只有读数框里的单位想要另一件事：压在数字的「基线」上，读起来才像「3 次」，
   * 而不是一个飘在数字半腰的小字。要把单位的基线对到数字的基线上，就得把两条
   * central 基线之差补回来，这个差值约等于 0.36em（数字字号与单位字号之差乘上它）。
   */
  var CENTRAL_BASELINE_DROP = 0.36

  /** 数值读数：标签 + 等宽数字 + 单位（工程皮肤的主力，插画皮肤当记分牌）。 */
  function readout(options) {
    var opts = options || {}
    var x = numberOf(opts.x, 0)
    var y = numberOf(opts.y, 0)
    var width = Math.max(96, numberOf(opts.w, 168))
    var height = Math.max(58, numberOf(opts.h, 84))
    var declaredHeight = height
    var metrics = readoutMetrics(opts.label, width)
    var pad = metrics.pad
    var labelSize = scaleVariable('--k12-fs-readout-label', 12.5)
    var valueSize = scaleVariable('--k12-fs-readout-value', 24)
    var unitSize = scaleVariable('--k12-fs-axis', 12.5)
    var label = opts.label == null ? '' : String(opts.label)
    var unit = opts.unit == null ? '' : String(opts.unit)

    if (metrics.needed > height) height = metrics.needed
    /*
     * 内容整块垂直居中：盒子被子带（或邻居）拉高时，标签与数字不该贴着上沿，
     * 否则下面空一大片，读数看着像没对齐。高度恰好够用时这里就是 pad，
     * 与「贴着上沿 + pad」完全等价，所以短盒子一个像素都没动。
     */
    var contentHeight = metrics.labelHeight + metrics.midGap + metrics.valueHeight
    var contentTop = y + (height - contentHeight) / 2
    var group = Sandbox.svgEl('g')
    group.setAttribute('class', 'k12-readout')
    var back = Sandbox.svgEl('rect')
    back.setAttribute('class', 'k12-readout-bg')
    back.setAttribute('x', String(x))
    back.setAttribute('y', String(y))
    back.setAttribute('width', String(width))
    back.setAttribute('height', String(height))
    back.setAttribute('rx', '12')
    group.appendChild(back)
    if (label) {
      paintText(group, label, {
        className: 'k12-readout-label',
        anchor: 'start',
        x: x + pad,
        y: contentTop + metrics.labelHeight / 2,
        maxWidth: width - pad * 2,
        fontSize: labelSize,
        minFontSize: 9.5,
        maxLines: 2
      })
    }
    // ★ 数值的**顶部**顶在标签底部之下（不是「距底边往上量」）：写死高度时的那种
    //   算法会让 27px 的数字往上吃掉标签 —— 两串字叠在一起，两个都读不出。
    var valueTop = contentTop + metrics.labelHeight + metrics.midGap
    var valueY = valueTop + metrics.valueHeight / 2
    var valueElement = null
    var unitElement = null
    if (unit) {
      unitElement = Sandbox.svgEl('text')
      unitElement.setAttribute('class', 'k12-readout-unit')
      unitElement.setAttribute('text-anchor', 'start')
      unitElement.setAttribute('dominant-baseline', 'central')
      unitElement.setAttribute('y', String(valueY))
      unitElement.style.fontSize = unitSize + 'px'
      unitElement.textContent = unit
      group.appendChild(unitElement)
    }
    function renderValue(next) {
      var text = next == null ? '' : String(next)
      if (valueElement && valueElement.parentNode) valueElement.parentNode.removeChild(valueElement)
      valueElement = paintText(group, text, {
        className: 'k12-readout-value',
        anchor: 'start',
        x: x + pad,
        y: valueY,
        maxWidth: width - pad * 2 - (unitElement ? unitSize * unit.length + 8 : 0),
        fontSize: valueSize,
        minFontSize: 12,
        maxLines: 1
      })
      var used = measuredWidth(valueElement)
      if (used <= 0) used = estimatedWidth(text, valueSize)
      if (unitElement) {
        // 单位落在数字的基线上（见 CENTRAL_BASELINE_DROP 的说明）。数字若被缩过号，
        // 就从画好的元素上把真实字号读回来，免得基线越缩越对不齐。
        var paintedSize = numberOf(
          valueElement && valueElement.style ? parseFloat(valueElement.style.fontSize) : NaN,
          valueSize
        )
        unitElement.setAttribute('x', String(x + pad + used + 5))
        unitElement.setAttribute('y', String(valueY + (paintedSize - unitSize) * CENTRAL_BASELINE_DROP))
      }
      return group
    }
    renderValue(opts.value == null ? '' : opts.value)
    attachTooltip(group, (label ? label + ' ' : '') + (opts.value == null ? '' : opts.value) + (unit ? ' ' + unit : ''))
    foregroundLayer().appendChild(group)
    group.back = back
    group.valueElement = valueElement
    group.unitElement = unitElement
    group.k12Box = { x: x, y: y, w: width, h: height }
    group.k12Grow = { declared: declaredHeight, actual: height, grew: height > declaredHeight + 0.01 }
    /** 改数值（读数面板的主要用法：在相位里更新它）。 */
    group.set = function (next) {
      return renderValue(next)
    }
    registerBox(group, 'readout')
    return group
  }

  /* ==================================================================== *
   * 自动布局层（zone / row / stack / measure）
   *
   * 给谁用：**批量生成模板的那条流水线**，以及任何想「描述意图而不是坐标」的模板。
   *
   * ★★ 这一层为什么必须存在（用户投诉的原话：「文字、图标、小人位置都是错位重叠的」）：
   *   旧写法里每个原型都手算坐标 —— `GAP = (668 - 150 * COUNT) / (COUNT + 1)`。COUNT 一变
   *   大，分子就变负 → 盒子互相压；文案一长，`node()` 为了「永不截断」自己长高 → 压住下一行；
   *   读数框固定在右下角 → 与步骤条挤在一起。这三件事的共同点是：
   *   **没有任何一处知道「别人占了多大地方」**。
   *
   * 这一层的规则只有三条，但足以让重叠**在构造上不可能**：
   *   ① `row()` 把可用宽度**均分**给格（先扣掉写死宽度的项，其余按 weight 分），
   *      行内每个盒子用**同一个高度** = 行里最费空间的那一项需要的高度 ——
   *      行内不可能互相压（谁也长不高，因为高度是按最费的那个给的）；
   *   ② 每个盒子的高度来自 `nodeMetrics/readoutMetrics/bubbleMetrics`，与基元内部**同一套
   *      算式**（不是另写一套估算）—— 规划与落地一致，`node()` 就不会临时长高；
   *   ③ `zone` 有一条**纵向游标**：后建的带自动排在前一条带的下方（含它实际用掉的高度），
   *      带与带之间也不可能压 —— 连「长高」都被下一条带照单接收。
   *
   * 坐标一律是 720×420 舞台坐标，内容默认落在安全边距内（见 SAFE_MARGIN 的说明）。
   * ==================================================================== */

  /** 纵向游标：下一个「没写 y 的」带从这里开始。 */
  var layoutCursor = SAFE_MARGIN

  /** 每一项「真实需要」的高度（与基元同一套算式）。 */
  function itemNeed(item, cellWidth) {
    var kind = String(item && item.kind == null ? 'node' : item && item.kind)
    if (kind === 'blank') return 0
    if (kind === 'readout') return readoutMetrics(item.label, cellWidth).needed
    if (kind === 'bubble') return bubbleMetrics(item.text, cellWidth, item.tail).needed
    if (kind === 'actor') {
      var scale = Math.max(0.4, numberOf(item.scale, 1))
      return 96 * scale + (item.label ? 30 : 0)
    }
    return nodeMetrics(item.label, item.sub, cellWidth).needed
  }

  /**
   * 把一行的可用宽度分成格子。
   *
   * 先扣掉写死宽度的项（`item.w`），剩下的按 `item.weight`（默认 1）均分；
   * 最后**兜一次底**：若总宽超出 `width`，所有格子按比例收缩 ——
   * 「格子加起来比行还宽」就是旧写法里那种负 gap 的来源，这里从算式上排除掉。
   */
  function planCells(items, width, gap) {
    var count = items.length
    var fixed = 0
    var weight = 0
    var index
    for (index = 0; index < count; index += 1) {
      var item = items[index] || {}
      if (item.w) fixed += Math.max(0, numberOf(item.w, 0))
      else weight += Math.max(0.2, numberOf(item.weight, 1))
    }
    var free = width - gap * (count - 1) - fixed
    var unit = weight > 0 && free > 0 ? free / weight : 0
    var cells = []
    var total = gap * (count - 1)
    for (index = 0; index < count; index += 1) {
      var one = items[index] || {}
      var cell = one.w ? Math.max(0, numberOf(one.w, 0)) : unit * Math.max(0.2, numberOf(one.weight, 1))
      cells.push(cell)
      total += cell
    }
    if (total > width && total > 0) {
      var factor = Math.max(0, width - gap * (count - 1)) / (total - gap * (count - 1) || 1)
      for (index = 0; index < count; index += 1) cells[index] = cells[index] * factor
    }
    return cells
  }

  /**
   * 保留一条横带。**没写 y 就自动排在上一条带的下方**（这就是「不重叠」的关键）。
   *
   * | 选项 | 默认 | 说明 |
   * | --- | --- | --- |
   * | `x, w` | 38 / 到右边距 | 带的左右边界 |
   * | `y` | 纵向游标 | 显式给 y 就不吃游标（少见的用法） |
   * | `h` | 0 | **下限**：带至少要这么高；里面的行比它高，带就按行的实际高度长 |
   * | `gap` | 16 | 带内默认的行间距 |
   *
   * 返回的带对象：`{ x, y, w, h, top, bottom, left, right, centerX, centerY, rect() }`
   * 外加三个排布方法：`row()` / `stack()` / `place()`。带用完自动把游标推到它的下沿。
   */
  function zone(options) {
    var opts = options || {}
    var left = numberOf(opts.x, SAFE_MARGIN + 4)
    var width = Math.max(120, numberOf(opts.w, STAGE_WIDTH - left * 2))
    var floor = Math.max(0, numberOf(opts.h, 0))
    var gap = Math.max(0, numberOf(opts.gap, 16))
    var top = opts.y == null ? layoutCursor : numberOf(opts.y, layoutCursor)
    var cursor = top
    var api = { x: left, y: top, w: width, h: floor, gap: gap }

    /** 把游标推到至少 bottom（带只会往下长，不会回头）。 */
    function advance(bottom) {
      cursor = Math.max(cursor, bottom)
      api.h = Math.max(floor, cursor - top)
      api.bottom = top + api.h
      api.left = api.x
      api.right = api.x + api.w
      api.centerX = api.x + api.w / 2
      api.centerY = top + api.h / 2
      layoutCursor = Math.max(layoutCursor, api.bottom)
    }

    /** 带自身的矩形（放读数框 / 人物 / 图例时用）。 */
    api.rect = function () {
      return { x: api.x, y: top, w: api.w, h: api.h, right: api.right, bottom: api.bottom }
    }

    /**
     * 横着排一行：格子均分、**整行同一个高度**（行里最费空间的那一项说了算）。
     *
     * `items` 每项可给：`kind`（node / readout / bubble / actor / blank）、
     * `label` / `sub`（node）、`text` / `who` / `tail`（bubble）、`value` / `unit`（readout）、
     * `tone` / `focus`、`w`（写死宽度）或 `weight`（按比例分）。
     *
     * 返回 `{ groups, boxes, centers, cells, height, top, bottom }`。
     */
    api.row = function (rowOptions) {
      var ro = rowOptions || {}
      var items = ro.items || []
      var count = items.length
      var rowGap = Math.max(0, numberOf(ro.gap, gap))
      var rowWidth = Math.max(60, numberOf(ro.w, width))
      var rowLeft = numberOf(ro.x, left)
      var rowTop = ro.y == null ? cursor : numberOf(ro.y, cursor)
      var result = { groups: [], boxes: [], centers: [], cells: [], top: rowTop, height: 0 }
      if (!count) {
        advance(rowTop)
        return result
      }
      var cells = planCells(items, rowWidth, rowGap)
      var height = Math.max(40, numberOf(ro.h, 0))
      var index
      for (index = 0; index < count; index += 1) {
        height = Math.max(height, itemNeed(items[index] || {}, cells[index]))
      }
      var x = rowLeft
      for (index = 0; index < count; index += 1) {
        var item = items[index] || {}
        var kind = String(item.kind == null ? 'node' : item.kind)
        var cell = Math.max(0, cells[index])
        var group = null
        if (kind === 'readout') {
          group = readout({
            x: x, y: rowTop, w: cell, h: height,
            label: item.label, value: item.value, unit: item.unit
          })
        } else if (kind === 'bubble') {
          var sized = bubbleMetrics(item.text, cell, item.tail)
          var bubbleX = String(item.tail) === 'right' ? x + cell - sized.width : x
          group = bubble({
            x: bubbleX, y: rowTop, w: cell,
            text: item.text, who: item.who, tail: item.tail
          })
        } else if (kind === 'actor') {
          group = actor({
            x: x + cell / 2, y: rowTop + height,
            pose: item.pose, label: item.label, scale: item.scale
          })
        } else if (kind !== 'blank') {
          group = node({
            x: x, y: rowTop, w: cell, h: height,
            label: item.label, sub: item.sub, tone: item.tone, focus: item.focus
          })
        }
        result.groups.push(group)
        result.boxes.push(group ? group.k12Box : null)
        result.centers.push(x + cell / 2)
        result.cells.push(cell)
        x += cell + rowGap
      }
      result.height = height
      result.bottom = rowTop + height
      advance(result.bottom)
      return result
    }

    /**
     * 竖着叠一摞（`anchor: 'top'` 自上而下；`'bottom'` 自下而上，用来「一层层往上搭」）。
     *
     * `inset` 让每高一层就左右各缩进一点 —— 「一层层搭起来」的塔形只要给一个数。
     * 每一层的高度是**它自己**需要的（不是一刀切），所以层与层之间也不会压。
     *
     * 返回 `{ groups, boxes, height, top, bottom, widths }`。
     */
    api.stack = function (stackOptions) {
      var so = stackOptions || {}
      var items = so.items || []
      var count = items.length
      var stackGap = Math.max(0, numberOf(so.gap, 10))
      var stackWidth = Math.max(60, numberOf(so.w, width))
      var stackX = numberOf(so.x, left)
      var inset = Math.max(0, numberOf(so.inset, 0))
      var upward = String(so.anchor) === 'bottom'
      var base = upward ? numberOf(so.base, cursor) : 0
      var start = upward ? base : numberOf(so.y, cursor)
      var result = { groups: [], boxes: [], widths: [], height: 0 }
      if (!count) {
        advance(start)
        return result
      }
      var widths = []
      var heights = []
      var index
      for (index = 0; index < count; index += 1) {
        var width = Math.max(48, stackWidth - inset * 2 * index)
        widths.push(width)
        heights.push(Math.max(40, itemNeed(items[index] || {}, width)))
      }
      var totalHeight = 0
      for (index = 0; index < count; index += 1) totalHeight += heights[index]
      totalHeight += stackGap * (count - 1)
      var line = upward ? start - totalHeight : start
      for (index = 0; index < count; index += 1) {
        var item = items[index] || {}
        var width2 = widths[index]
        var group = null
        var x = stackX + (stackWidth - width2) / 2
        if (String(item.kind) === 'readout') {
          group = readout({ x: x, y: line, w: width2, h: heights[index], label: item.label, value: item.value, unit: item.unit })
        } else if (String(item.kind) === 'bubble') {
          var sized = bubbleMetrics(item.text, width2, item.tail)
          group = bubble({ x: x, y: line, w: width2, text: item.text, who: item.who, tail: item.tail })
        } else {
          group = node({ x: x, y: line, w: width2, h: heights[index], label: item.label, sub: item.sub, tone: item.tone, focus: item.focus })
        }
        result.groups.push(group)
        result.boxes.push(group ? group.k12Box : null)
        result.widths.push(width2)
        line += heights[index] + stackGap
      }
      result.height = totalHeight
      result.top = upward ? start - totalHeight : start
      result.bottom = upward ? start : start + totalHeight
      advance(result.bottom)
      return result
    }

    /**
     * 带里放一个**不参与分行**的块（读数框 / 人物 / 图例）：给个尺寸和对齐方式，
     * 还你一个矩形，你自己拿它去建基元。
     */
    api.place = function (placeOptions) {
      var po = placeOptions || {}
      var width2 = Math.max(0, numberOf(po.w, 0))
      var height2 = Math.max(0, numberOf(po.h, 0))
      var align = String(po.align == null ? 'left' : po.align)
      var valign = String(po.valign == null ? 'top' : po.valign)
      var x = left
      if (align === 'right') x = left + width - width2
      else if (align === 'center') x = left + (width - width2) / 2
      else if (typeof po.x === 'number') x = po.x
      var y = top
      if (valign === 'bottom') y = top + api.h - height2
      else if (valign === 'middle') y = top + (api.h - height2) / 2
      if (typeof po.y === 'number') y = po.y
      return { x: x, y: y, w: width2, h: height2, right: x + width2, bottom: y + height2, centerX: x + width2 / 2, centerY: y + height2 / 2 }
    }

    advance(top + floor)
    return api
  }

  /** 不带带的独立一行（等于 `Sandbox.zone({ h: 0 }).row(...)`，写法短一点）。 */
  function row(options) {
    var opts = options || {}
    var band = zone({ x: opts.x, w: opts.w, y: opts.y, h: numberOf(opts.h, 0), gap: numberOf(opts.gap, 16) })
    return band.row(opts)
  }

  /** 不带带的独立一摞。 */
  function stack(options) {
    var opts = options || {}
    var band = zone({ x: opts.x, w: opts.w, y: opts.y, h: 0, gap: numberOf(opts.gap, 10) })
    return band.stack(opts)
  }

  /**
   * 量一量：这段文字在指定宽度下要多大的盒子（**与基元同一套算式**）。
   *
   * 用途：同一格里要轮播好几段文案时（读数框 / 气泡），按**最大的那一段**预留尺寸，
   * 这样轮播过程中盒子一次都不会长大 —— 也就不会去压邻居。
   */
  function measure(options) {
    var opts = options || {}
    var width = Math.max(48, numberOf(opts.w, 180))
    var kind = String(opts.kind == null ? 'node' : opts.kind)
    if (kind === 'readout') {
      var rm = readoutMetrics(opts.label, width)
      return { width: width, height: Math.max(58, rm.needed) }
    }
    if (kind === 'bubble') {
      var bm = bubbleMetrics(opts.text, width, opts.tail)
      return { width: bm.width, height: bm.needed }
    }
    var nm = nodeMetrics(opts.label, opts.sub, width)
    return { width: width, height: Math.max(40, nm.needed) }
  }

  /* ==================================================================== *
   * 声明式布局：Sandbox.layout(plan)
   *
   * 给谁用：批量生成流水线。生成侧在**离线**就把每一格的位置、尺寸、文案算好
   * （`preset-content/_meta/gen_animations.py` 的 Planner，与这里的 zone/row/stack
   * 同一套规则），运行时**照单全收**照着建 —— 于是：
   *
   *   · 生成侧能拿这份清单做**静态守卫**（盒子不重叠 / 不出舞台 / 标签≠副标题 /
   *     人物站得下），不用真的开浏览器；
   *   · 运行时能拿它做**对账**（实际画出来比清单大就要记账），两边的数一旦不一致，
   *     当场在 `window.__K12_LAYOUT__` 里留痕，而不是悄悄压住邻居。
   *
   * 清单（plan）的形状：
   *
   *     {
   *       bands: [ { id, x, y, w, h, gap } ],
   *       cells: [ { id, band, kind, x, y, w, h, label, sub, text, who, tail,
   *                  value, unit, tone, focus } ],       // kind 见下面 buildCell
   *       actors: [ { id, x, y, pose, scale, label } ],      // x,y 是**脚底**
   *       rails: [ { id, from, to, style, directed, label } ]  // from/to: [x,y] 或盒子 id
   *     }
   *
   * 返回 `{ bands, boxes, actors, rails, order, list, one, center, audit }` ——
   * `boxes` / `actors` / `rails` 都是「id → 基元组」，直接拿去做动画。
   * ==================================================================== */
  function layout(plan) {
    var source = plan || {}
    var result = { bands: {}, boxes: {}, actors: {}, rails: {}, plots: {}, tracks: {}, ids: [] }
    var index
    // 最后再声明一次，免得老引擎把 `result.tracks` 当成未定义
    result.tracks = result.tracks || {}

    var bands = source.bands || []
    for (index = 0; index < bands.length; index += 1) {
      var band = bands[index] || {}
      var bx = numberOf(band.x, SAFE_MARGIN)
      var by = numberOf(band.y, SAFE_MARGIN)
      var bw = Math.max(0, numberOf(band.w, 0))
      var bh = Math.max(0, numberOf(band.h, 0))
      result.bands[band.id] = {
        id: band.id, x: bx, y: by, w: bw, h: bh,
        top: by, bottom: by + bh, left: bx, right: bx + bw,
        centerX: bx + bw / 2, centerY: by + bh / 2
      }
      // 带也记进账本（守卫要拿它算「内容有没有超出安全区」）
      layoutJournal.push({ kind: 'band', id: band.id, x: bx, y: by, w: bw, h: bh })
    }

    /** 按清单建一格（**尺寸照单全收**，运行时不再自己算位置）。 */
    function buildCell(cell) {
      var kind = String(cell.kind == null ? 'node' : cell.kind)
      var box = {
        x: numberOf(cell.x, 0), y: numberOf(cell.y, 0),
        w: numberOf(cell.w, 120), h: numberOf(cell.h, 60)
      }
      if (kind === 'readout') {
        return readout({ x: box.x, y: box.y, w: box.w, h: box.h, label: cell.label, value: cell.value, unit: cell.unit })
      }
      if (kind === 'bubble') {
        return bubble({ x: box.x, y: box.y, w: box.w, text: cell.text, who: cell.who, tail: cell.tail })
      }
      if (kind === 'text') {
        var textGroup = Sandbox.svgEl('g')
        textGroup.setAttribute('class', 'k12-node-sub')
        paintText(textGroup, cell.label, {
          className: 'k12-node-sub',
          x: box.x + box.w / 2,
          y: box.y + box.h / 2,
          maxWidth: box.w,
          fontSize: scaleVariable('--k12-fs-node-sub', 12),
          minFontSize: 9.5,
          maxLines: 2
        })
        foregroundLayer().appendChild(textGroup)
        textGroup.k12Box = { x: box.x, y: box.y, w: box.w, h: box.h }
        textGroup.k12Grow = { declared: box.h, actual: box.h, grew: false }
        // 纯注释文字不参与碰撞判定（它没有底板，压在一起也只是「文字靠得近」），
        // 但仍然要待在舞台里 —— 见 audit()。
        textGroup.k12Soft = true
        registerBox(textGroup, 'text')
        return textGroup
      }
      return node({
        x: box.x, y: box.y, w: box.w, h: box.h,
        label: cell.label, sub: cell.sub, tone: cell.tone, focus: cell.focus
      })
    }

    /** 对账：实际画出来的盒子比清单大就是**长高**了 —— 记账，别装作没发生。 */
    function reconcile(id, planned, group) {
      if (!group || !group.k12Box) return group
      var box = group.k12Box
      if (box.h > planned.h + 0.5 || box.w > planned.w + 0.5) {
        layoutJournal.push({
          kind: 'overflow', id: id,
          planned: { x: planned.x, y: planned.y, w: planned.w, h: planned.h },
          actual: { x: box.x, y: box.y, w: box.w, h: box.h }
        })
      } else {
        layoutJournal.push({ kind: 'box', id: id, x: box.x, y: box.y, w: box.w, h: box.h })
      }
      return group
    }

    var cells = source.cells || []
    for (index = 0; index < cells.length; index += 1) {
      var cell = cells[index] || {}
      var rect = {
        x: numberOf(cell.x, 0), y: numberOf(cell.y, 0),
        w: numberOf(cell.w, 120), h: numberOf(cell.h, 60)
      }
      var group = buildCell(cell)
      if (!group) continue
      /*
       * 把清单身份写在 DOM 上（两个读者）：
       *   `data-k12-id`    这一格是哪一件（QA 与守卫按它取件，不靠 CSS 猜）；
       *   `data-k12-slot`  同位轮换的槽位名 —— **同一槽位的成员占同一个矩形**，
       *                    同一时刻只显示一个，所以它们之间从来不算「重叠」
       *                    （守卫与截图检查都按这个属性分组）。
       */
      group.setAttribute('data-k12-id', String(cell.id))
      if (cell.alt) group.setAttribute('data-k12-slot', String(cell.alt))
      result.boxes[cell.id] = reconcile(cell.id, rect, group)
      result.ids.push(cell.id)
    }

    var rails = source.rails || []
    for (index = 0; index < rails.length; index += 1) {
      var rail = rails[index] || {}
      var from = rail.from
      var to = rail.to
      if (typeof from === 'string' && result.boxes[from]) from = result.boxes[from]
      if (typeof to === 'string' && result.boxes[to]) to = result.boxes[to]
      var railGroup = link(from, to, { style: rail.style, directed: rail.directed, label: rail.label })
      result.rails[rail.id] = railGroup
      result.ids.push(rail.id)
    }

    /*
     * 绘图区（坐标图 / 跑道）：清单里就带几何，运行时**照单画一条可见的轨道**
     * （`kind: 'ellipse'` 画椭圆跑道，其余只登记位置 —— 坐标轴由模板自己用
     * `Sandbox.axis()` 建在同一个矩形上）。它同时是「不许压住别的东西」的一条记录。
     */
    var plots = source.plots || []
    for (index = 0; index < plots.length; index += 1) {
      var plot = plots[index] || {}
      var plotGroup = Sandbox.svgEl('g')
      plotGroup.setAttribute('class', 'k12-plot')
      var px = numberOf(plot.x, 0)
      var py = numberOf(plot.y, 0)
      var pw = Math.max(0, numberOf(plot.w, 0))
      var ph = Math.max(0, numberOf(plot.h, 0))
      if (plot.kind === 'ellipse') {
        var oval = Sandbox.svgEl('ellipse')
        oval.setAttribute('class', 'k12-track')
        oval.setAttribute('cx', String(numberOf(plot.cx, px + pw / 2)))
        oval.setAttribute('cy', String(numberOf(plot.cy, py + ph / 2)))
        oval.setAttribute('rx', String(numberOf(plot.rx, pw / 2)))
        oval.setAttribute('ry', String(numberOf(plot.ry, ph / 2)))
        plotGroup.appendChild(oval)
      }
      foregroundLayer().appendChild(plotGroup)
      plotGroup.cx = numberOf(plot.cx, px + pw / 2)
      plotGroup.cy = numberOf(plot.cy, py + ph / 2)
      plotGroup.rx = numberOf(plot.rx, pw / 2)
      plotGroup.ry = numberOf(plot.ry, ph / 2)
      plotGroup.k12Box = { x: px, y: py, w: pw, h: ph }
      plotGroup.k12Grow = { declared: ph, actual: ph, grew: false }
      // 绘图区是「一条记录」而不是一个实心盒子：它不参与盒盒重叠判定，但必须待在舞台里
      plotGroup.k12Soft = true
      plotGroup.k12Plot = true
      result.plots[plot.id] = plotGroup
      result.ids.push(plot.id)
    }

    var actors = source.actors || []
    for (index = 0; index < actors.length; index += 1) {
      var one = actors[index] || {}
      var actorX = numberOf(one.x, 0)
      var actorY = numberOf(one.y, 0)
      /*
       * ★★ 两层结构（实测缺陷：对话原型里小人被切在画布上沿、脚底跑到 y=33）。
       *
       * 根因：anime 的 `scale` / `translateX` 写的是 **style.transform**，而 style 会
       *   **整个盖掉** 元素自己的 `transform="translate(x y) scale(s)"` 属性 ——
       *   于是任何「动一下小人」的动画都把他弹回原点（位置丢了、缩放也没了）。
       *   旧写法把位置留在人物自己身上、外面那层 pivot 是空的 translate(0 0)，
       *   所以「动画 pivot」同样是错的（pivot 在原点，缩放会把人往原点拖）。
       *
       * 修法与模板侧的 `pivot()` 助手同构：
       *   ① 外层 `seat`：只负责**摆位置**（translate），任何动画都不碰它；
       *   ② 内层 `pivot`：不带任何 transform 属性，动画只在它身上发生 ——
       *      style.transform 从空开始写，不会覆盖掉位置。
       *   `k12Pivot` 指向内层，模板要动小人时动它。
       */
      var actorGroup = actor({
        x: 0, y: 0,
        pose: one.pose, label: one.label, scale: one.scale
      })
      var seat = Sandbox.svgEl('g')
      seat.setAttribute('class', 'k12-actor-seat')
      seat.setAttribute('transform', 'translate(' + actorX + ' ' + actorY + ')')
      var pivot = Sandbox.svgEl('g')
      pivot.setAttribute('class', 'k12-actor-pivot')
      foregroundLayer().appendChild(seat)
      seat.appendChild(pivot)
      pivot.appendChild(actorGroup)
      // 内层要有 fill-box + origin:center，这样 scale 是绕小人自己转（不是绕舞台原点）
      pivot.style.transformBox = 'fill-box'
      pivot.style.transformOrigin = 'center'
      actorGroup.k12Pivot = pivot
      actorGroup.k12Seat = seat
      if (one.track) {
        result.tracks[one.id] = { from: numberOf(one.track[0], 0), to: numberOf(one.track[1], 0) }
      }
      result.actors[one.id] = actorGroup
      result.ids.push(one.id)
      // 人物的**锚点**（脚底）也记一笔：守卫要查「站的地方讲不讲得通」
      layoutJournal.push({ kind: 'anchor', id: one.id, x: actorX, y: actorY })
    }

    /** 按 id 前缀取一组（`list('station')` → station-0 / station-1 …，按编号排序）。 */
    result.list = function (prefix) {
      var out = []
      for (var k = 0; k < result.ids.length; k += 1) {
        var id = result.ids[k]
        if (id.indexOf(prefix) !== 0) continue
        var tail = id.slice(prefix.length).replace(/^[-_]/, '')
        if (tail !== '' && !/^\d+$/.test(tail)) continue
        out.push({ id: id, group: result.pick(id), index: tail === '' ? 0 : parseInt(tail, 10) })
      }
      out.sort(function (a, b) { return a.index - b.index })
      var list = []
      for (var j = 0; j < out.length; j += 1) list.push(out[j].group)
      return list
    }

    /** 按 id 取件（盒子 / 人物 / 连线 / 绘图区，谁在就取谁）。 */
    result.pick = function (id) {
      return result.boxes[id] || result.actors[id] || result.rails[id] || result.plots[id] || null
    }

    /** 取单件（`one('meter')`）。 */
    result.one = result.pick

    /** 某个盒子的中心（连接线、人物走位用它，别自己再算一遍）。 */
    result.center = function (id) {
      var target = result.one(id)
      if (!target) return { x: 0, y: 0 }
      if (target.k12Anchor) return { x: target.k12Anchor.x, y: target.k12Anchor.y }
      if (!target.k12Box) return { x: 0, y: 0 }
      return { x: target.k12Box.x + target.k12Box.w / 2, y: target.k12Box.y + target.k12Box.h / 2 }
    }

    /**
     * 自检：把这一份舞台的**实际几何**过一遍 —— 盒盒重叠 / 跑出舞台 / 长高。
     *
     * 这是给 QA 与守卫用的（`window.__K12_LAYOUT__` 里也有原始记录）。返回的数组为空
     * 就说明这一屏是干净的。
     */
    result.audit = function () {
      var problems = []
      var all = []
      var id
      for (id in result.boxes) {
        if (!Object.prototype.hasOwnProperty.call(result.boxes, id)) continue
        var item = result.boxes[id]
        if (!item || !item.k12Box) continue
        all.push({ id: id, box: item.k12Box, soft: !!item.k12Soft, slot: item.getAttribute('data-k12-slot') || '' })
      }
      for (id in result.plots) {
        if (!Object.prototype.hasOwnProperty.call(result.plots, id)) continue
        var plot = result.plots[id]
        if (!plot || !plot.k12Box) continue
        all.push({ id: id, box: plot.k12Box, soft: true })
      }
      for (var a = 0; a < all.length; a += 1) {
        var boxA = all[a].box
        if (boxA.x < 0 || boxA.y < 0 || boxA.x + boxA.w > STAGE_WIDTH || boxA.y + boxA.h > STAGE_HEIGHT) {
          problems.push({ kind: 'bounds', id: all[a].id })
        }
        if (all[a].soft) continue
        for (var b = a + 1; b < all.length; b += 1) {
          if (all[b].soft) continue
          // 同一个槽位的轮换成员占同一个矩形（同一时刻只显示一个）——不算重叠
          if (all[a].slot && all[a].slot === all[b].slot) continue
          var boxB = all[b].box
          var overX = Math.min(boxA.x + boxA.w, boxB.x + boxB.w) - Math.max(boxA.x, boxB.x)
          var overY = Math.min(boxA.y + boxA.h, boxB.y + boxB.h) - Math.max(boxA.y, boxB.y)
          if (overX > 1 && overY > 1) {
            problems.push({ kind: 'overlap', a: all[a].id, b: all[b].id, overX: overX, overY: overY })
          }
        }
      }
      for (index = 0; index < layoutJournal.length; index += 1) {
        if (layoutJournal[index].kind === 'overflow') problems.push(layoutJournal[index])
      }
      return problems
    }

    return result
  }

  /* ---------------------------------------------------------------- *
   * 外壳：字幕行 / 步骤条
   * ---------------------------------------------------------------- */

  /** 更新字幕行（优先 #caption，其次第一个 .anim-caption）。 */
  function caption(text) {
    var element = document.getElementById('caption') || document.querySelector('.anim-caption')
    if (!element) return null
    element.textContent = text == null ? '' : String(text)
    return element
  }

  /**
   * 更新步骤条（找不到 .chip 就在 #stage 末尾补一个）。
   *
   * ★★ `total` 与 `index` 数的是**位置**，不是相位（2026-09-26，D-087）。
   *   相位里含「布景 / 收尾」两拍，它们不是位置 —— 旧实现让步骤条去数相位
   *   （`共 COUNT+2 步`），于是**同一段收尾里字幕说「一共 4 段」而步骤条说「共 6 步」**，
   *   节点徽标又写着「第 1…4 段」：同一时刻三个坐标系，学生读不出「讲到哪了」。
   *   现在：序言/收尾**不调用本函数**（chip 保留模板自己的初始文案，如「准备出发」），
   *   每个位置调一次、序号与该动画字幕里的编号**同值**。
   * ★ `unit` 是这套动画自己的量词（段 / 站 / 层 / 条 / 件 / 行 / 组 / 轮 / 圈 / 次 / 个问题 / 步）：
   *   步骤条是**运行时元素不是内容文案**，让它说内容已经在用的那个词，
   *   一个动画就只有一套说法 —— 而内容里的句子一个字都不用改。
   */
  function step(index, total, unit) {
    var chip = document.querySelector('#stage .chip') || document.querySelector('.chip')
    if (!chip) {
      var master = document.getElementById('stage') || document.body
      if (!master) return null
      chip = document.createElement('span')
      chip.setAttribute('class', 'chip')
      chip.setAttribute('id', 'k12-step-chip')
      master.appendChild(chip)
    }
    var word = typeof unit === 'string' && unit ? unit : '步'
    var value = Math.max(0, Math.round(numberOf(index, 0)))
    var count = Math.round(numberOf(total, 0))
    chip.textContent =
      count > 0 ? '第 ' + value + ' ' + word + ' / 共 ' + count + ' ' + word : '第 ' + value + ' ' + word
    chip.setAttribute('data-step', String(value))
    if (count > 0) chip.setAttribute('data-step-total', String(count))
    return chip
  }

  /* ---------------------------------------------------------------- *
   * 分相位时间线
   * ---------------------------------------------------------------- */

  /**
   * 分相位时间线：``builder(tl, index, helpers)`` 返回该相位要播的动画。
   *
   * 相位之间自动插入 ``motion.holdMs`` 的停顿（学生需要时间看结果），进度按
   * 「已过毫秒 / 总时长」上报给宿主（暂停时不报，由运行时那一层统一拦）。
   *
   * 返回值就是 ``Sandbox.play(impl)`` 需要的东西（``{pause, play, restart, finished}``）：
   *
   *     Sandbox.play(function () {
   *       return Sandbox.timeline(3, function (tl, index, helpers) {
   *         if (index === 0) return { targets: node1.body, opacity: [0, 1] }
   *         return [{ targets: node2.body, opacity: [0, 1] }, { targets: node3.body, ... }]
   *       })
   *     })
   *
   * ★ 返回数组时逐条 add：anime 的 ``timeline.add(数组)`` 会被当成**关键帧**（实测：
   *   ``add([a, b])`` 得到一条默认 1000ms 的关键帧动画，而不是两条），那是另一个语义。
   */
  function timeline(stepCount, builder) {
    var count = Math.max(1, Math.round(numberOf(stepCount, 1)))
    var motion = MOTION
    if (typeof anime === 'undefined' || !anime || typeof anime.timeline !== 'function') {
      // 动画库没内联（演练开关 / 坏产物）：给一个空壳，让宿主照常走完上报链路
      reportError(new Error('动画库没有加载，Sandbox.timeline 无法创建时间线'))
      var stub = { pause: function () {}, play: function () {}, restart: function () {} }
      stub.finished = { then: function (onDone) { if (typeof onDone === 'function') onDone(); return stub.finished } }
      return stub
    }
    var instance = anime.timeline({ autoplay: false, easing: motion.easing, duration: motion.duration })
    var helpers = {
      motion: motion,
      total: count,
      easing: motion.easing,
      duration: motion.duration,
      holdMs: motion.holdMs,
      stagger: motion.stagger,
      /** 第 index 个相位大概从第几毫秒开始（做精细对齐时才用）。 */
      at: function (index) { return Math.max(0, Math.round(numberOf(index, 0))) * (motion.duration + motion.holdMs) },
      /** 直接往时间线上加（builder 自己加时不返回值即可）。 */
      add: function (params) { instance.add(params); return helpers },
      stage: stage,
      grid: grid,
      axis: axis,
      node: node,
      actor: actor,
      bubble: bubble,
      link: link,
      readout: readout,
      caption: caption,
      step: step
    }
    var index
    for (index = 0; index < count; index += 1) {
      if (index > 0 && motion.holdMs > 0) instance.add({ duration: motion.holdMs, easing: 'linear' })
      if (typeof builder !== 'function') continue
      var produced = builder(instance, index, helpers)
      if (produced == null) continue
      if (Object.prototype.toString.call(produced) === '[object Array]') {
        for (var item = 0; item < produced.length; item += 1) {
          if (produced[item] != null) instance.add(produced[item])
        }
      } else {
        instance.add(produced)
      }
    }

    var totalDuration = Math.max(1, Math.round(numberOf(instance.duration, 1)))
    var clock = { startedAt: 0, elapsed: 0, running: false }
    var ticker = null
    /**
     * 本轮的「播完了」回执。
     *
     * ★ 为什么是**一个数组**而不是一个变量（实测踩到）：宿主的重播路径是
     *   ``currentAnimation.restart()`` —— 它会把 pending 换成新的一轮。若只留最后一个
     *   resolver，**重启前挂上的那个 ``finished.then`` 永远不会被兑现**（promise 泄漏；
     *   若调用方 await 它，那一轮就永久挂住）。实测：连播两轮，第一轮的回执始终 pending。
     *   所以每轮各留一个 resolver，完成时**一起兑现**：对调用方来说都是「动画播完了」。
     */
    var pendingResolvers = []

    function newRunPromise() {
      if (typeof window.Promise === 'function') {
        var promise = new window.Promise(function (resolve) {
          pendingResolvers.push(resolve)
        })
        return promise
      }
      // 没有 Promise 的老环境：给一个 thenable（回执语义一致，只是不能链式）
      return {
        then: function (onDone, onFail) {
          pendingResolvers.push(function () {
            if (typeof onDone === 'function') onDone()
          })
          return this
        }
      }
    }

    function finish() {
      if (ticker) {
        clearInterval(ticker)
        ticker = null
      }
      clock.running = false
      var resolvers = pendingResolvers
      pendingResolvers = []
      for (var index = 0; index < resolvers.length; index += 1) {
        try {
          resolvers[index]()
        } catch (error) {
          reportError(error)
        }
      }
      return true
    }

    function tick() {
      if (!clock.running) return
      var elapsed = clock.elapsed + (Date.now() - clock.startedAt)
      var progress = Math.min(1, elapsed / totalDuration)
      Sandbox.progress(progress) // 节流 + 「暂停不上报」在运行时那一层统一处理
      if (progress >= 1) finish()
    }

    function startClock() {
      clock.startedAt = Date.now()
      clock.running = true
      if (!ticker) ticker = setInterval(tick, 100)
    }

    function pauseClock() {
      if (!clock.running) return
      clock.elapsed += Date.now() - clock.startedAt
      clock.running = false
    }

    var runPromise = newRunPromise()

    var handle = {
      pause: function () {
        pauseClock()
        try { instance.pause() } catch (error) { reportError(error) }
        return handle
      },
      play: function () {
        if (instance.completed) return handle.restart()
        startClock()
        try { instance.play() } catch (error) { reportError(error) }
        return handle
      },
      restart: function () {
        clock.elapsed = 0
        clock.running = false
        runPromise = newRunPromise() // ★ 重播换一个新回执（宿主会在 restart 之后挂它）
        try { instance.restart() } catch (error) { reportError(error) }
        startClock()
        return handle
      },
      /** thenable：宿主的 start() 会 attach 它，播完即宣告 100%。 */
      finished: {
        then: function (onDone, onFail) { return runPromise.then(onDone, onFail) }
      },
      // —— 以下为非冻结的补充（做精细控制时才用）——
      anime: instance,
      duration: totalDuration,
      phases: count
    }
    startClock()
    try { instance.play() } catch (error) { reportError(error) }
    return handle
  }

  var Sandbox = {
    payloadId: PAYLOAD_ID,
    throttleMs: PROGRESS_THROTTLE_MS,
    /** SVG 命名空间（见上面的说明）。模板统一用 `Sandbox.SVG_NS`，不要自己写字面量。 */
    SVG_NS: SVG_NS,
    /** `createElementNS` 的简写：`Sandbox.svgEl('rect')`。 */
    svgEl: function (tag) {
      return document.createElementNS(SVG_NS, tag)
    },
    post: post,
    reportError: reportError,
    reportProgress: reportProgress,
    /** 注册「播放时怎么动」；返回值应为 anime.js 的动画实例（可 pause/play/restart）。 */
    play: function (impl) {
      playImpl = impl
    },
    /** 可选：自定义进度取值（默认由动画进度回推）。 */
    onProgress: function (impl) {
      progressImpl = impl
    },
    /** 报告 ready（在模板初始化完成后调用一次）。`ready` 只在首次播报。 */
    ready: function (detail) {
      if (readySent) return
      readySent = true
      post('ready', detail || {})
    },
    /** 手动上报进度（每个模板都可以在动画 update 回调里调用它）。 */
    progress: function (value) {
      reportProgress(typeof progressImpl === 'function' ? progressImpl(value) : value)
    },
    /** 主动开始播放（也允许模板自己调 anime()，不必走这里）。 */
    start: start,
    /** 模板拿到自己的动画实例后登记进来，宿主才能 pause / replay。 */
    attach: function (animation) {
      currentAnimation = animation
      return animation
    },

    /* ---- 舞台基元（冻结接口，详见 preset-content/_meta/STAGE-API.md） ---- */
    /** 当前学段：'primary_low' | 'primary_high' | 'junior' | 'senior'（缺省 'default'）。 */
    grade: GRADE,
    /** 当前皮肤：'illustrated'（小学）| 'technical'（中学以上）。 */
    skin: SKIN,
    /** 动效预设 ``{ duration, easing, stagger, holdMs }`` —— 按皮肤不同，模板别自己写死。 */
    motion: MOTION,
    /** 建（或取）720×420 的 SVG 舞台，返回 ``{ svg, width, height }``。 */
    stage: stage,
    /** 背景网格（工程皮肤里明显，插画皮肤里几乎是暗示）。 */
    grid: grid,
    /** 坐标轴，返回的组上带 ``plot``（轴围出来的绘图区）。 */
    axis: axis,
    /** 节点：圆角矩形 + 居中文字（+ 可选副标题）。 */
    node: node,
    /** 人物（插画皮肤的当家角色）。 */
    actor: actor,
    /** 气泡。 */
    bubble: bubble,
    /** 连接线（a / b 传 node() 的返回值或 {x,y,w,h}）。 */
    link: link,
    /** 数值读数（等宽数字，返回的组上带 ``set(value)``）。 */
    readout: readout,
    /** 保留一条横带（后建的带自动排在前一条下方）—— 自动布局的入口。 */
    zone: zone,
    /** 一行盒子：宽度均分、整行同一个高度（重叠在构造上不可能）。 */
    row: row,
    /** 一摞盒子：自上而下 / 自下而上，可逐层缩进（塔形）。 */
    stack: stack,
    /** 量一段文字需要多大的盒子（与基元同一套算式；轮播文案按最大的一段预留）。 */
    measure: measure,
    /** 声明式布局：把一份算好的清单（bands / cells / actors / rails）**照单**画出来。 */
    layout: layout,
    /** 舞台安全区（内容默认落在这里面，别去碰外壳的字幕行与步骤条）。 */
    safe: {
      x: SAFE_MARGIN,
      y: SAFE_MARGIN,
      width: STAGE_WIDTH - SAFE_MARGIN * 2,
      height: STAGE_HEIGHT - SAFE_MARGIN - SAFE_BOTTOM_MARGIN,
      bottom: STAGE_HEIGHT - SAFE_BOTTOM_MARGIN
    },
    /** 分相位时间线，返回值可直接交给 ``Sandbox.play``。 */
    timeline: timeline,
    /** 更新字幕行。 */
    caption: caption,
    /** 更新步骤条。 */
    step: step
  }

  window.Sandbox = Sandbox
})()
