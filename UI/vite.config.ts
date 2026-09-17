import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

/**
 * 独立预览环境：只服务 UI 原型，不接 desktop/ 的 IPC 与契约。
 * 后续接线时，src/ 可整体迁入 desktop/src/renderer，vite 配置按 electron-vite 迁移。
 */
export default defineConfig({
  plugins: [
    vue(),
    AutoImport({
      imports: ['vue', 'vue-router', 'pinia'],
      resolvers: [ElementPlusResolver()],
      dts: 'src/types/auto-imports.d.ts'
    }),
    Components({
      resolvers: [ElementPlusResolver()],
      dirs: ['src/components', 'src/cards'],
      dts: 'src/types/components.d.ts'
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    port: 5273,
    strictPort: false
  },
  build: {
    // 设计稿为 1440 宽固定画布，此处不引入 CDN，全部本地打包（断网演示硬约束）
    assetsInlineLimit: 4096
  }
})
