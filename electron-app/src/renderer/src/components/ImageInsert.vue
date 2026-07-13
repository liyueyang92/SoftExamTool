<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  questionId: string | null
  fieldName: 'content' | 'options' | 'explanation'
}>()

const emit = defineEmits<{
  insert: [html: string]
}>()

const uploading = ref(false)

async function handleClick() {
  try {
    const filePath = await window.electronAPI.pickImageFile()
    if (!filePath) return
    await uploadAndInsert(filePath)
  } catch (e) {
    console.error('[ImageInsert] pick failed:', e)
  }
}

async function uploadAndInsert(sourcePath: string) {
  if (!props.questionId) {
    // Save the path temporarily; the parent can call upload after question is created
    emit('insert', `<!-- pending-image:${sourcePath} -->`)
    return
  }
  uploading.value = true
  try {
    const result = await window.electronAPI.uploadQuestionImage({
      question_id: props.questionId,
      field_name: props.fieldName,
      source_path: sourcePath,
    })
    emit('insert', `<img src="exam-image://${result.imageId}" alt="" />`)
  } catch (e) {
    console.error('[ImageInsert] upload failed:', e)
  } finally {
    uploading.value = false
  }
}

// Listen for paste events containing images
function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  for (const item of items) {
    if (item.type.startsWith('image/')) {
      e.preventDefault()
      // For clipboard images, we need the main process to handle the save
      const file = item.getAsFile()
      if (!file) continue
      // In Electron, File from clipboard may not have a path
      // We'd need to handle this via a separate IPC that accepts base64 data
      // For now, use the file path if available
      if ((file as any).path) {
        uploadAndInsert((file as any).path)
      }
      break
    }
  }
}

// Only apply paste listener when questionId is available (editing existing question)
// Otherwise we just emit pending markers
</script>

<template>
  <button
    class="img-insert-btn"
    :disabled="uploading"
    title="插入图片"
    type="button"
    @click="handleClick"
  >
    {{ uploading ? '⏳' : '🖼' }}
  </button>
</template>

<style scoped>
.img-insert-btn {
  background: none;
  border: 1px solid #555;
  border-radius: 4px;
  cursor: pointer;
  padding: 2px 6px;
  font-size: 14px;
  line-height: 1;
  color: #ccc;
  flex-shrink: 0;
}
.img-insert-btn:hover {
  border-color: #888;
  background: #333;
}
.img-insert-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
