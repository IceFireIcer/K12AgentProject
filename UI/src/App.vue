<script setup lang="ts">
/**
 * 应用根：语言包 + 全局单实例的模态层。
 *
 * 全局模态层（确认框、模型选择器）挂在这里而不是各页里 —— 它们是**跨页**的：
 * 学生在哪一页都可能需要切换模型，而确认框同一时刻只该存在一个。
 */
import { RouterView } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ModelPicker from '@/components/ModelPicker.vue'
import { useConfirm } from '@/stores/confirm'

const confirm = useConfirm()
</script>

<template>
  <!-- 中文语言包：EP 的日期、分页、上传等组件默认英文 -->
  <el-config-provider :locale="zhCn">
    <RouterView />

    <!-- 全局模态：确认框（Promise 语义，见 stores/confirm.ts） -->
    <ConfirmDialog
      :open="confirm.open"
      :title="confirm.options.title"
      :body="confirm.options.body"
      :danger="confirm.options.danger"
      :confirm-text="confirm.options.confirmText"
      :cancel-text="confirm.options.cancelText"
      @confirm="confirm.onConfirm()"
      @cancel="confirm.onCancel()"
    />

    <!-- 全局模态：模型 / 供应商选择器（对话页、设置页、顶栏都可唤起） -->
    <ModelPicker />
  </el-config-provider>
</template>
