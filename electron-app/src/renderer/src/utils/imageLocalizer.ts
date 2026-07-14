/**
 * Scans HTML content for <img> tags with remote (https://) URLs and replaces
 * them with local exam-image:// references by downloading through the main process.
 *
 * Returns the modified HTML. Already-local images are left unchanged.
 */

const IMG_SRC_RE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi

export interface LocalizeResult {
  html: string
  replaced: number // how many URLs were replaced
}

export async function localizeRemoteImages(html: string): Promise<LocalizeResult> {
  if (!html || !html.includes('<img')) {
    return { html, replaced: 0 }
  }

  const matches = [...html.matchAll(IMG_SRC_RE)]
  const toLocalize: Array<{ tag: string; url: string }> = []

  for (const match of matches) {
    const fullTag = match[0]
    const url = match[1]
    // Only process remote https/http URLs
    if (url.startsWith('https://') || url.startsWith('http://')) {
      toLocalize.push({ tag: fullTag, url })
    }
  }

  if (toLocalize.length === 0) {
    return { html, replaced: 0 }
  }

  // Download all remote images in parallel
  const promises = toLocalize.map(async ({ tag, url }) => {
    try {
      const res = await window.electronAPI.ensureLocalImage({ url })
      if (!res.success) return { tag, newTag: tag }
      const localUrl = (res.data as { localUrl: string }).localUrl
      if (localUrl === url) return { tag, newTag: tag } // download failed, keep original
      const newTag = tag.replace(url, localUrl)
      return { tag, newTag }
    } catch {
      return { tag, newTag: tag } // keep original on error
    }
  })

  const results = await Promise.all(promises)
  let result = html
  let replaced = 0
  for (const { tag, newTag } of results) {
    if (newTag !== tag) {
      result = result.replace(tag, newTag)
      replaced++
    }
  }

  return { html: result, replaced }
}
