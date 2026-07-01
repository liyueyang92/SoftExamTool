import { isRef, toRaw, unref } from 'vue'

export function toIpcPayload<T>(value: T): T {
  if (isRef(value)) {
    return toIpcPayload(unref(value)) as T
  }

  if (value === null || value === undefined) return value

  if (value instanceof Date) {
    return new Date(value.getTime()) as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => toIpcPayload(item)) as T
  }

  if (typeof value !== 'object') return value

  const raw = toRaw(value as object) as Record<string, unknown>
  const plain: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(raw)) {
    plain[key] = toIpcPayload(entry)
  }
  return plain as T
}
