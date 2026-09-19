(function () {
  function rect(el) { var b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b2: Math.round(b.bottom) } }
  function visible(el) { var b = el.getBoundingClientRect(); var cs = getComputedStyle(el); return b.width > 0 && b.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
  var out = { vw: window.innerWidth, vh: window.innerHeight, clipped: [], hOverflow: null, outside: [] }
  var de = document.documentElement
  out.hOverflow = de.scrollWidth > de.clientWidth + 1 ? { sw: de.scrollWidth, cw: de.clientWidth } : null
  // ★★ 只报**内容真的够不着**的那种裁切（本轮实测踩过假阳性）：
  //   `overflow-x: auto|scroll` 是**刻意的横向滚动条**（长列表/关卡条/模板条都靠它），
  //   用户滚一下就能看到 —— 那不是缺陷，把它算进来会淹掉真问题（白排查一轮）。
  //   真正的缺陷是 `overflow-x: hidden/filter`（含 clip）+ 内容超出：
  //   既没有省略号、也不能滚，**内容永久不可达**。
  //   （`text-overflow: ellipsis` 也是可接受的表达 —— 那是在明说「这里被截断了」。）
  // ★ 排除**已知哨兵值**：Monaco 把内部的 `.editor-scrollable` 的 scrollWidth
  //   写成 16777215 / 16777216（2²⁴-1 / 2²⁴），表示「不参与测量」——
  //   而它自己的横向滚动由 `.scrollbar.horizontal` 承担，内容并不真的够不着。
  //   不排除的话每次都会报一条假阳性（实测踩到）。
  var SENTINELS = [16777215, 16777216]
  document.querySelectorAll('*').forEach(function (el) {
    if (SENTINELS.indexOf(el.scrollWidth) >= 0) return
    if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
      var cs = getComputedStyle(el)
      var ox = cs.overflowX
      var scrollableByUser = ox === 'auto' || ox === 'scroll'
      var saysTruncated = cs.textOverflow === 'ellipsis'
      if (!scrollableByUser && !saysTruncated && ox !== 'visible') {
        var b = el.getBoundingClientRect()
        if (b.width > 40 && b.height > 12) out.clipped.push({ cls: String(el.className).split(' ').slice(0,2).join('.'), sw: el.scrollWidth, cw: el.clientWidth, ox: ox })
      }
    }
  })
  out.clipped = out.clipped.slice(0, 6)
  // 跑出视口右侧的元素（忽略刻意横向滚动的容器内部）
  function inHScroll(el) {
    // 祖先里有没有「用户可以横向滚动」的容器 —— 有就不算「跑出视口」（滚一下就能看到）
    var n = el.parentElement
    while (n) {
      var cs = getComputedStyle(n)
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') return true
      n = n.parentElement
    }
    return false
  }
  document.querySelectorAll('.shell__main button, .shell__main input, .shell__main textarea, .shell__main .k12-card, .shell__main article').forEach(function (el) {
    if (!visible(el)) return
    if (inHScroll(el)) return
    var b = el.getBoundingClientRect()
    if (b.right > window.innerWidth + 2 || b.left < -2) out.outside.push({ cls: String(el.className).split(' ').slice(0,2).join('.'), r: rect(el) })
  })
  out.outside = out.outside.slice(0, 6)
  // 表格：表头与表体的宽度必须一致（Element Plus 在横向溢出时**表头不跟着表体收**，
  // 于是表头被切掉一半、且与表体错位 —— 实测 1280 下「向量」列只剩一个「向」字）
  var hw = document.querySelector('.el-table__header-wrapper')
  var bw = document.querySelector('.el-table__body-wrapper')
  out.table = (hw && bw) ? { headerW: hw.scrollWidth, bodyW: bw.scrollWidth, clipped: hw.scrollWidth > hw.clientWidth + 1, aligned: hw.scrollWidth === bw.scrollWidth } : null

  // 触控目标下限
  var tiny = []
  document.querySelectorAll('.shell__main button, .shell__main [role="button"]').forEach(function (el) {
    if (!visible(el)) return
    var b = el.getBoundingClientRect()
    if (Math.min(b.width, b.height) < 20 || Math.max(b.width, b.height) < 28) tiny.push((el.innerText||el.title||el.tagName).trim().slice(0,14) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height))
  })
  out.tiny = tiny.slice(0, 6)
  return JSON.stringify(out)
})()
