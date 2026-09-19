import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 与 tsconfig.node.json / tsconfig.web.json 的 paths 保持一致：
//   @shared/*   → src/shared/*          （主进程与渲染进程共用，如 6 事件词表）
//   @renderer/* → src/renderer/src/*    （仅渲染进程）
//   @/*         → src/renderer/src/*    （渲染进程内相对别名，与移植过来的界面一致）
const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    // 依赖不打包进产物（node_modules 由 electron-builder 分发），保证原生模块不被 rollup 破坏
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        output: {
          // ★★ 票 03：主进程必须产出 **ESM**（→ out/main/index.mjs）。
          //
          // 原因（实测，不是推测）：`@earendil-works/pi-coding-agent` 是纯 ESM 包，
          // 它的 exports 映射**只有 `import` 条件**，没有 `require`：
          //     { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } }
          // 所以在 CJS 产物里对它的 `require()` 直接抛
          //     ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined
          // —— 而 `externalizeDepsPlugin()` 恰好会把依赖原样留成 `require()`，两者必然冲突。
          // 复现：`node scripts/pi-import-graph.mjs`（同时打印 ESM import 与 CJS require 的结果）。
          //
          // 备选方案「不 external 化、把 Pi 打进 bundle」被否决：Pi 依赖 jiti 动态加载扩展、
          // 依赖 @mariozechner/clipboard 按平台动态 require `.node`，rollup 打包会打坏这些动态解析。
          //
          // ⚠️ 代价：ESM 产物里没有 `__dirname`，主进程代码一律改用 `import.meta.dirname`。
          format: 'es',
          entryFileNames: '[name].mjs'
        }
      }
    }
  },
  preload: {
    // preload 保持 CJS：`sandbox: false` 下 CJS preload 是 Electron 最稳的形态，
    // 与「主进程 ESM」互不影响（两者是各自独立的构建目标）。
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    // ★ 票 18：自托管的 Pyodide 运行时放在 desktop/resources/pyodide/，
    //   必须拷进渲染产物才可能离线可用（任何 CDN 引用都会在断网演示时白屏）。
    publicDir: resolve('resources'),
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve('src/renderer/src'),
        '@': resolve('src/renderer/src')
      }
    },
    plugins: [
      vue(),
      // ── 自动导入与自动注册（移植界面所依赖的两条链路）─────────────────
      //
      // 界面源码里有 ~45 个文件，它们：
      //   ① 用 `ref` / `computed` / `watch` 等 API 而**不写 import**；
      //   ② 用 `<el-button>` 这类 Element Plus 组件而**不写 import、不注册**。
      // 这正是原型的约定；保留它才能「移植即用」，否则要重写几百处导入。
      //
      // ⚠️ **不引入 vue-router**：Electron 单窗口没有 URL / 后退 / 深链需求，
      //   导航的唯一真相是 `stores/ui.ts`（见该文件注释）。
      //   引进来会造成「router 与 store 双真相」，并且让 `ui-shell.test.ts`
      //   与 `verify-ui.mjs` 的 `view-entry` 循环同时失效。
      AutoImport({
        imports: ['vue', 'pinia'],
        resolvers: [ElementPlusResolver()],
        // ★ 路径**相对于渲染进程的 vite root**（= `src/renderer`），不是 desktop 根 ——
        //   写成 `src/renderer/src/types/...` 会被解析到 `src/renderer/src/renderer/src/types/`，
        //   于是真正的类型声明文件永远停在旧版本（typecheck 也不会报，因为那份不在 include 里）。
        dts: 'src/types/auto-imports.d.ts'
      }),
      Components({
        resolvers: [ElementPlusResolver()],
        // ⚠️ `dirs` 与 `dts` 都是**相对渲染进程 vite root（`src/renderer`）** 解析的。
        //   实证：`dts: 'src/types/components.d.ts'` 落在 `src/renderer/src/types/`。
        //   所以组件目录要写成 `src/components` / `src/cards`（对应 `src/renderer/src/...`）。
        //   写错时**不报错、不警告**，只是「一个自定义组件都没注册」——
        //   运行期由 Vue 自己解析模板，所以不会炸；只在 TS 里表现为类型缺失。
        dirs: ['src/components', 'src/cards'],
        dts: 'src/types/components.d.ts'
      })
    ]
  }
})
