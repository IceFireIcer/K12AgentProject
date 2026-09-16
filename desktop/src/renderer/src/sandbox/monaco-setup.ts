/**
 * Monaco 编辑器的**本地装配**（票 18）。
 *
 * ---------------------------------------------------------------------------
 * ★ 为什么必须单独一个文件：Monaco 需要 worker 配置，不配会在**生产构建**报错
 * ---------------------------------------------------------------------------
 *
 * Monaco 自己也要 Web Worker（编辑器内核、词法分析都在 worker 里跑）。
 * 用 vite 打包时，如果不告诉 Monaco「worker 从哪来」，它在开发态可能侥幸能跑
 * （vite 的 dev server 会兜住），但**生产构建会报 worker 相关错误/运行期 404** ——
 * 这是业务陷阱清单 §7 第 4 条点名要防的事。
 *
 * 做法是给 `self.MonacoEnvironment.getWorker` 一个 vite 认得的 `?worker` 入口：
 *
 *     const { default: EditorWorker } = await import(
 *       'monaco-editor/editor/editor.worker?worker'
 *     )
 *     self.MonacoEnvironment = { getWorker: () => new EditorWorker() }
 *
 * ⚠️ **说明符必须写成 `monaco-editor/editor/editor.worker?worker`**（不是 `.../esm/vs/...`）。
 *    实测（`vite build`，monaco 0.56）：`monaco-editor/esm/vs/editor/editor.worker?worker`
 *    会直接**构建失败**：
 *
 *        [vite]: Rollup failed to resolve import
 *        "monaco-editor/esm/vs/editor/editor.worker?worker"
 *
 *    原因是 monaco 0.56 的 `exports` 映射是 `"./*": "./esm/vs/*.js"` —— 写全 `esm/vs/…`
 *    会被映射成 `esm/vs/esm/vs/…` 而对不上。写**短形式** `monaco-editor/editor/...`
 *    由 exports 映射成 `esm/vs/editor/editor.worker.js`，vite 才能把 worker 单独打成一个
 *    chunk（实测产物 `assets/editor.worker-*.js`，约 585 kB）。
 *    **这一条正是业务陷阱清单 §7 第 4 条说的「不配会在生产构建报错」。**
 *
 * ★ **只需要 `editor.worker` 一个**：本项目只用 Python（`basic-languages` 里的词法高亮，
 * 不需要独立的语言服务 worker）。TS/JSON/CSS/HTML 那四个 worker 我们一个都不碰，
 * 所以不必为它们各写一条映射 —— 少配一条就少一处打包风险。
 *
 * ---------------------------------------------------------------------------
 * ★ 离线自托管（任何 CDN 引用都是断网演示的必然翻车点）
 * ---------------------------------------------------------------------------
 *
 * Monaco 的资源**全部由 vite 从 `node_modules/monaco-editor/` 打包进产物**：
 * 没有 `vs/loader.js` 的 CDN 引导、没有 `require.config({paths})`、
 * 没有 `cdn.jsdelivr.net` / `unpkg`。本文件里**一个网络地址都没有**。
 * （业务陷阱清单 §7 第 6 条：任何 CDN 引用都会在断网演示时翻车。）
 *
 * ---------------------------------------------------------------------------
 * ★ 懒加载：进编程卡片才加载
 * ---------------------------------------------------------------------------
 *
 * 本文件**不在模块顶层 import monaco** —— Monaco 是几百 KB 的大家伙，
 * 对话页上九成时间用不到它。{@link createCodeEditor} 内部用**动态 import**，
 * vite 因此会把它切成独立 chunk：只有编程卡片真的打开时才拉取。
 * 这和 Pyodide 的懒加载口径一致（`sandbox/pyodide-runner.ts` 也只在进卡片时创建 Worker）。
 *
 * ---------------------------------------------------------------------------
 * 语言与主题
 * ---------------------------------------------------------------------------
 *
 * 语言固定 `python`；主题默认 `vs`（浅色，与卡片的白底协调），
 * 学生可用 {@link setEditorTheme} 切到 `vs-dark`（票 18 的"展开/全屏"之外的小福利，
 * 不引入任何额外资源）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- monaco 的类型面很大，只声明用到的部分 */

/** 编辑器实例的最小结构面（避免在组件里散落 `any`）。 */
export interface CodeEditorHandle {
  /** 取当前源码（学生改动后的最新版本）。 */
  getValue(): string
  /** 整段替换（切换知识点 / 重置为脚手架时用）。 */
  setValue(text: string): void
  /** 是否只读（运行期间可锁住，避免"边跑边改"）。 */
  setReadOnly(readOnly: boolean): void
  /** 切换主题。 */
  setTheme(theme: CodeEditorTheme): void
  /** 重算布局（卡片展开/全屏/窗口尺寸变化后必须调用，否则编辑器会留白或裁切）。 */
  layout(): void
  /** 聚焦（打开卡片后把光标放进去）。 */
  focus(): void
  /** 释放（组件卸载时必须调用，否则会留下监听器与 DOM 引用）。 */
  dispose(): void
}

export type CodeEditorTheme = 'vs' | 'vs-dark'

/** 默认主题（浅色，与卡片底色一致）。 */
export const DEFAULT_EDITOR_THEME: CodeEditorTheme = 'vs'

/** Monaco 用的语言 id（契约里 `CodeTemplate.language` 固定 `"python"`）。 */
export const EDITOR_LANGUAGE = 'python'

/** 学生代码的编辑器选项（教学取向：行号、自动换行、**关掉代码提示的噪声**）。 */
export function editorOptions() {
  return {
    language: EDITOR_LANGUAGE,
    theme: DEFAULT_EDITOR_THEME,
    // 自动换行：K12 学生写不出超长行，但粘贴进来的示例常有 —— 横向滚动会让人找不到北
    wordWrap: 'on' as const,
    lineNumbers: 'on' as const,
    // 缩进用 4 空格（与教材里的 Python 示例一致；Tab 会让缩进错误更难发现）
    tabSize: 4,
    insertSpaces: true,
    detectIndentation: false,
    // 关掉自动补全/参数提示：教学场景里"猜出答案"会削弱思考（陷阱：直接给答案的软性版本）
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    // 关掉 minimap 与滚动条装饰：小卡片里它们只占地方
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    // 字体：等宽，与设计系统的 --font-mono 同族（回退链保证本机一定有字体可用）
    fontFamily:
      "ui-monospace, 'Cascadia Mono', Consolas, 'Courier New', 'Microsoft YaHei Mono', monospace",
    fontSize: 13,
    lineHeight: 20,
    // 编辑器自己滚动，不把整页撑开（卡片高度固定）
    scrollbar: { alwaysConsumeMouseWheel: false },
    automaticLayout: false, // 由我们用 ResizeObserver 显式 layout（更可控）
    renderLineHighlight: 'line' as const,
    contextmenu: true,
    // ★ 只读的"灰色遮罩"关掉：我们只在运行时临时只读，不需要视觉降级
    readOnly: false,
    domReadOnly: false
  }
}

/** 模块级缓存：Monaco 只装配一次（多次 `import` 是幂等的，但 MonacoEnvironment 只需设一次）。 */
let monacoModule: any = null
let monacoReady: Promise<any> | null = null

/**
 * 懒加载并装配 Monaco（**幂等**）。
 *
 * ★ 这里是"进卡片才加载"的落点：动态 `import()` 让 vite 把 Monaco 切成独立 chunk，
 * 页面初始化时不会拉它（对话为主的应用不该为编程卡片付启动成本）。
 *
 * 同时完成 worker 装配 —— **必须在任何 `monaco.editor.create` 之前**，
 * 否则 Monaco 会去猜 worker 地址（生产构建下就是那个 404）。
 */
export async function loadMonaco(): Promise<any> {
  if (monacoReady) return await monacoReady

  monacoReady = (async () => {
    // ★ 动态 import：这一行是懒加载的关键（vite 据此切 chunk）。
    //
    // ⚠️ **不要 import 'monaco-editor'（包根）**。实测（vite build，monaco 0.56）：
    //    包根 `esm/vs/index.js` 会 register **每一种**语言，还会拉进
    //    `external/monaco-lsp-client` —— 于是生产产物里出现五个语言服务 worker：
    //
    //        ts.worker   13,307 kB
    //        css.worker   1,909 kB
    //        html.worker  1,285 kB
    //        json.worker    883 kB
    //        ─────────────────────── 约 17.4 MB，本项目**一个都用不到**
    //
    //    改用 `editor/editor.api`（编辑器内核 + 语言注册表，不含任何内置语言）
    //    + 只注册 Python 一个语言贡献，这 17.4 MB 全部消失，
    //    产物里只剩 `editor.worker` 与 `python-*.js`。
    const monaco = await import('monaco-editor/editor/editor.api')
    // 只注册 Python 的高亮（K12 的编程练习就是 Python；契约 `language` 也固定 "python"）
    await import('monaco-editor/basic-languages/monaco.contribution')
    // ★ 说明符必须是这个**短形式**（见文件头：`esm/vs/...` 会让生产构建直接失败）
    const { default: EditorWorker } = await import('monaco-editor/editor/editor.worker?worker')

    // ★ 告诉 Monaco：worker 用这个 vite 打出来的入口。
    //   只映射 `editorWorkerService` —— 我们只注册了 Python 的词法高亮，
    //   没有语言服务（LSP），所以不存在 ts/json/css/html 那四个 worker 的需求。
    ;(self as unknown as { MonacoEnvironment?: unknown }).MonacoEnvironment = {
      getWorker: (): Worker => new EditorWorker()
    }

    monacoModule = monaco
    return monaco
  })()

  return await monacoReady
}

/** 已装配的 Monaco（未加载时返回 `null`）。 */
export function loadedMonaco(): any {
  return monacoModule
}

export interface CreateEditorOptions {
  /** 宿主 DOM 节点（必须已经在文档里且有尺寸）。 */
  container: HTMLElement
  /** 初始源码（通常是模板的 `scaffold`）。 */
  value: string
  /** 只读（运行期间可临时锁住）。 */
  readOnly?: boolean
  theme?: CodeEditorTheme
  /** 内容变化回调（用于"学生改过没有"的判断与提示）。 */
  onChange?: (value: string) => void
}

/**
 * 建一个代码编辑器（**异步**：内部会先 `loadMonaco()`）。
 *
 * 返回的句柄是**最小面**：组件不需要认识 Monaco 的类型，
 * 也就不会因为升级 monaco 版本而在业务代码里到处报类型错。
 */
export async function createCodeEditor(options: CreateEditorOptions): Promise<CodeEditorHandle> {
  const monaco = await loadMonaco()
  const editor = monaco.editor.create(options.container, {
    ...editorOptions(),
    value: options.value,
    readOnly: options.readOnly ?? false,
    theme: options.theme ?? DEFAULT_EDITOR_THEME
  })

  // 内容变化：交给宿主组件（例如"改过之后再点运行"的引导）
  const subscription =
    typeof options.onChange === 'function'
      ? editor.onDidChangeModelContent(() => {
          options.onChange?.(editor.getValue())
        })
      : null

  return {
    getValue: () => editor.getValue(),
    setValue: (text: string) => editor.setValue(text),
    setReadOnly: (readOnly: boolean) => editor.updateOptions({ readOnly }),
    setTheme: (theme: CodeEditorTheme) => {
      monaco.editor.setTheme(theme)
    },
    layout: () => editor.layout(),
    focus: () => editor.focus(),
    dispose: () => {
      subscription?.dispose()
      // 先 dispose model 再 dispose editor：只 dispose editor 会留下 model 引用（内存泄漏）
      const model = editor.getModel()
      editor.dispose()
      model?.dispose()
    }
  }
}

/**
 * 用 `ResizeObserver` 把容器尺寸变化接到 `editor.layout()`。
 *
 * 为什么需要：卡片有"内联 / 展开 / 全屏"三种形态（执行文档 §11.1 的布局口径），
 * 每次形态变化容器尺寸都变；Monaco **不会**自己感知（它把 `automaticLayout: false` 交给我们），
 * 不调用 `layout()` 就会出现"编辑器还停留在旧高度"的空白或裁切。
 *
 * 返回取消函数（组件卸载时调用）。
 */
export function observeEditorResize(container: HTMLElement, handle: CodeEditorHandle): () => void {
  if (typeof ResizeObserver === 'undefined') return () => {}
  const observer = new ResizeObserver(() => {
    // Monaco 的 layout 很便宜，但连续拖动窗口时会很密集 —— 用 rAF 合并到每帧一次
    requestAnimationFrame(() => handle.layout())
  })
  observer.observe(container)
  return () => observer.disconnect()
}
