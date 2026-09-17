<script setup lang="ts">
import { RouterView } from 'vue-router'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
</script>

<template>
  <!-- 中文语言包：EP 的日期、分页、上传等组件默认英文 -->
  <el-config-provider :locale="zhCn">
    <RouterView />
  </el-config-provider>
</template>
