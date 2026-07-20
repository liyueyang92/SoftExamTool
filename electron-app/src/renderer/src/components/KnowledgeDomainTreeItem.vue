<script setup lang="ts">
import { computed } from 'vue'
import { useKnowledgeDomainStore, type KnowledgeDomainTreeNode } from '../stores/knowledge-domain'

const props = defineProps<{
  node: KnowledgeDomainTreeNode
  depth: number
  selectedId: string | null
}>()

const emit = defineEmits<{
  (e: 'select', id: string): void
  (e: 'add-child', parentId: string): void
  (e: 'edit', node: KnowledgeDomainTreeNode): void
  (e: 'delete', id: string): void
}>()

const domainStore = useKnowledgeDomainStore()

const hasChildren = computed(() => props.node.children && props.node.children.length > 0)
const isExpanded = computed(() => !!domainStore.expandedIds[props.node.id])
const isSelected = computed(() => props.selectedId === props.node.id)

function handleToggle() {
  emit('select', props.node.id)
  if (hasChildren.value) {
    domainStore.toggleExpand(props.node.id)
  }
}

function getLevelLabel(level: number): string {
  return { 1: '一级', 2: '二级', 3: '三级' }[level] ?? ''
}
</script>

<template>
  <div class="tree-item">
    <div
      class="node-row"
      :class="{ selected: isSelected }"
      :style="{ paddingLeft: depth * 20 + 8 + 'px' }"
    >
      <span
        class="chevron"
        :class="{ expanded: isExpanded, invisible: !hasChildren }"
        @click.stop="handleToggle"
      >▸</span>
      <span class="node-name" @click="handleToggle">
        {{ node.name }}
      </span>
      <span class="badge level-badge" :class="'lvl-' + node.level">
        {{ getLevelLabel(node.level) }}
      </span>
      <span class="badge weight-badge" v-if="node.weight_pct > 0">
        {{ node.weight_pct }}%
      </span>
      <span class="badge time-badge" v-if="node.suggested_min > 0">
        {{ node.suggested_min }}min
      </span>
      <span class="node-actions">
        <button v-if="node.level < 3" class="btn-xs btn-ghost" title="添加子知识点"
          @click.stop="emit('add-child', node.id)">+</button>
        <button class="btn-xs btn-ghost" title="编辑"
          @click.stop="emit('edit', node)">✎</button>
        <button class="btn-xs btn-ghost btn-danger" title="删除"
          @click.stop="emit('delete', node.id)">✕</button>
      </span>
    </div>
    <div v-show="isExpanded" class="children">
      <KnowledgeDomainTreeItem
        v-for="child in node.children"
        :key="child.id"
        :node="child"
        :depth="depth + 1"
        :selected-id="selectedId"
        @select="emit('select', $event)"
        @add-child="emit('add-child', $event)"
        @edit="emit('edit', $event)"
        @delete="emit('delete', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.tree-item { user-select: none; }
.node-row {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 8px; border-radius: 4px; cursor: pointer;
  transition: background 0.15s; margin: 1px 0;
}
.node-row:hover { background: var(--c-panel); }
.node-row.selected { background: var(--c-accent); color: #fff; }
.chevron {
  display: inline-flex; align-items: center; justify-content: center;
  width: 16px; height: 16px; font-size: 10px;
  transition: transform 0.15s; flex-shrink: 0; color: var(--c-text-muted, #999);
}
.chevron.expanded { transform: rotate(90deg); }
.chevron.invisible { visibility: hidden; }
.node-name {
  flex: 1; font-size: 13px; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.badge {
  font-size: 10px; padding: 1px 6px; border-radius: 8px; flex-shrink: 0; opacity: 0.8;
}
.level-badge { background: var(--c-border); color: var(--c-text); }
.level-badge.lvl-1 { background: #e8f0fe; color: #1a56db; }
.level-badge.lvl-2 { background: #fef3c7; color: #92400e; }
.level-badge.lvl-3 { background: #f0fdf4; color: #166534; }
.weight-badge { background: #fce7f3; color: #9d174d; font-weight: 600; }
.time-badge { color: var(--c-text-muted, #888); }
.node-actions {
  display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; flex-shrink: 0;
}
.node-row:hover .node-actions { opacity: 1; }
.btn-xs {
  padding: 2px 6px; font-size: 11px; border: none; border-radius: 3px;
  cursor: pointer; background: transparent; color: var(--c-text); line-height: 1;
}
.btn-xs:hover { background: var(--c-border); }
.btn-danger:hover { background: #fee2e2; color: #dc2626; }
</style>
