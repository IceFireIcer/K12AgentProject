<script setup lang="ts">
/**
 * 设置：供应商 / 嵌入 / 主题 / 隐私。
 *
 * ⚠️ 学段设置**不存在**（§5.1）：这里没有学段选择项，只有只读说明。
 * ⚠️ API Key 保存前必须做**真实连通性探测**（执行文档要求）：
 *    注意 Pi 内置 DeepSeek 的 baseUrl 是 https://api.deepseek.com（**无 /v1**），
 *    与前端默认形如 /v1 的写法不同，保存时不能只存不验。
 */
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { Cpu, Database, Palette, ShieldCheck, Plug, Eye, EyeOff, Server, HardDrive } from 'lucide-vue-next'
import { useThemeStore, SATS } from '@/stores/theme'
import { settings } from '@/mocks'

const theme = useThemeStore()

const llm = reactive({ ...settings.llm, apiKey: '' })
const emb = reactive({ ...settings.embedding })
const probing = ref(false)
const showKey = ref(false)

function probe() {
  probing.value = true
  // 原型不发真实请求；接线时这里调用 sidecar 的探测端点并展示真实结果
  window.setTimeout(() => {
    probing.value = false
    ElMessage({
      message: '原型未接线：保存时须走后端真实探测（Pi 内置 DeepSeek 的 baseUrl 无 /v1）',
      type: 'warning'
    })
  }, 600)
}
</script>

<template>
  <div class="st">
    <!-- 供应商 -->
    <section class="card">
      <header class="card__head">
        <Plug :size="14" />
        <h2 class="card__title">主模型供应商</h2>
        <span class="card__meta">支持自定义 BaseURL / Model ID</span>
      </header>
      <el-form label-position="top" class="form">
        <el-form-item label="供应商名称">
          <el-input v-model="llm.providerName" placeholder="deepseek" />
        </el-form-item>
        <el-form-item label="BaseURL">
          <el-input v-model="llm.baseUrl" placeholder="https://api.deepseek.com/v1" />
          <p class="hint">Pi 内置 DeepSeek provider 的 baseUrl 无 <code>/v1</code>；保存时以真实探测结果为准。</p>
        </el-form-item>
        <el-form-item label="Model ID">
          <el-input v-model="llm.modelId" placeholder="deepseek-chat" />
        </el-form-item>
        <el-form-item label="API Key">
          <div class="row-inline">
            <el-input
              v-model="llm.apiKey"
              :type="showKey ? 'text' : 'password'"
              :placeholder="llm.hasKey ? '已保存（留空则不修改）' : '请输入 API Key'"
            />
            <el-button text @click="showKey = !showKey">
              <component :is="showKey ? EyeOff : Eye" :size="14" />
            </el-button>
          </div>
          <p class="hint">API Key 仅本地存储，不写入日志。</p>
        </el-form-item>
      </el-form>
      <div class="card__foot">
        <el-button :loading="probing" @click="probe">连通性探测</el-button>
        <el-button type="primary">保存</el-button>
      </div>
    </section>

    <!-- 嵌入 -->
    <section class="card">
      <header class="card__head">
        <Database :size="14" />
        <h2 class="card__title">嵌入模型</h2>
        <span class="card__meta">本地 CPU 推理</span>
      </header>
      <div class="kv-list">
        <div class="kv">
          <span class="kv__k">当前模式</span>
          <span class="kv__v">本地 fastembed</span>
        </div>
        <div class="kv">
          <span class="kv__k">模型</span>
          <code class="kv__code">{{ emb.modelId }}</code>
        </div>
        <div class="kv">
          <span class="kv__k">维度</span>
          <span class="kv__v">512</span>
        </div>
      </div>
      <p class="hint">
        不引入 torch，不依赖 Ollama。升级到 bge-base-zh-v1.5（768 维）须同步改 vec0 维度并重建索引。
      </p>
    </section>

    <!-- 主题：只读学段 + 饱和度 -->
    <section class="card">
      <header class="card__head">
        <Palette :size="14" />
        <h2 class="card__title">主题</h2>
        <span class="card__meta">学段色调由系统决定</span>
      </header>

      <div class="field">
        <p class="field__label">当前学段色调（只读）</p>
        <div class="readonly">
          <span class="k12-dot readonly__dot" />
          <span class="readonly__text">{{ theme.gradeIndicatorText }}</span>
        </div>
        <p class="hint">
          这里没有学段选择器 —— 学段由系统自动推断并生效，学生端只读。
        </p>
      </div>

      <div class="field">
        <p class="field__label">饱和度</p>
        <el-radio-group v-model="theme.sat">
          <el-radio-button v-for="s in SATS" :key="s.key" :value="s.key">
            {{ s.label }}
          </el-radio-button>
        </el-radio-group>
        <p class="hint">{{ theme.satMeta.desc }}</p>
      </div>
    </section>

    <!-- 隐私与本地化 -->
    <section class="card">
      <header class="card__head">
        <ShieldCheck :size="14" />
        <h2 class="card__title">隐私与本地化</h2>
      </header>
      <div class="kv-list">
        <div class="kv"><Server :size="13" /><span class="kv__k">数据存储</span><span class="kv__v">全本地，不上传</span></div>
        <div class="kv"><HardDrive :size="13" /><span class="kv__k">对话历史</span><span class="kv__v">Pi JSONL（每人一份）</span></div>
        <div class="kv"><Cpu :size="13" /><span class="kv__k">代码执行</span><span class="kv__v">渲染进程 Worker 隔离</span></div>
      </div>
      <p class="hint">
        涉未成年人数据：最小化采集，不采集生物特征；对话正文不进 SQLite。
      </p>
    </section>
  </div>
</template>

<style scoped>
.st {
  padding: 16px 20px 20px;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  align-items: start;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border-radius: var(--k12-r-4xl);
  background: var(--k12-glass);
  backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--k12-glass-blur)) saturate(180%);
  border: 1px solid var(--k12-glass-border);
}
.card__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--k12-muted);
}
.card__title {
  font-size: var(--k12-fs-lg);
  font-weight: 650;
  color: var(--k12-fg);
}
.card__meta {
  margin-left: auto;
  font-size: var(--k12-fs-micro);
  color: var(--k12-muted-2);
}
.card__foot {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.form :deep(.el-form-item) {
  margin-bottom: 12px;
}
.form :deep(.el-form-item__label) {
  padding-bottom: 4px;
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.row-inline {
  display: flex;
  gap: 6px;
  width: 100%;
}
.hint {
  margin-top: 5px;
  font-size: var(--k12-fs-micro);
  line-height: 1.7;
  color: var(--k12-muted);
}
.hint code {
  font-family: var(--k12-font-mono);
  font-size: 9.5px;
  padding: 1px 4px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-surface-2);
  color: var(--k12-accent);
}

.kv-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.kv {
  display: flex;
  align-items: center;
  gap: 9px;
}
.kv__k {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.kv__v {
  margin-left: auto;
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg);
}
.kv__code {
  margin-left: auto;
  font-family: var(--k12-font-mono);
  font-size: var(--k12-fs-micro);
  padding: 2px 6px;
  border-radius: var(--k12-r-xs);
  background: var(--k12-accent-soft);
  color: var(--k12-accent);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.field__label {
  font-size: var(--k12-fs-xs);
  color: var(--k12-muted);
}
.readonly {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  padding: 8px 12px;
  border-radius: var(--k12-r-lg);
  background: var(--k12-surface-2);
  border: 1px solid var(--k12-border);
}
.readonly__dot {
  background: var(--k12-good);
}
.readonly__text {
  font-size: var(--k12-fs-xs);
  font-weight: 620;
  color: var(--k12-fg);
}
</style>
