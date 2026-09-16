import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// 与 tsconfig.node.json / tsconfig.web.json 的 paths 保持一致：
//   @shared/*  → src/shared/*          （主进程与渲染进程共用，如 6 事件词表）
//   @renderer/* → src/renderer/src/*   （仅渲染进程）
const sharedAlias = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    // 依赖不打包进产物（node_modules 由 electron-builder 分发），保证原生模块不被 rollup 破坏
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: {
      alias: {
        ...sharedAlias,
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [vue()]
  }
})
