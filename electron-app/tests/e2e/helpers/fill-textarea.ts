/**
 * Reliably set a textarea value in Electron's renderer and trigger Vue 3 v-model.
 *
 * Playwright's `locator.fill()` dispatches a synthetic input event that Electron's
 * renderer process sometimes drops before Vue's reactivity layer sees it, leaving
 * the reactive ref stale.  The native-setter trick dispatches a real InputEvent
 * that Vue's vModelText directive always picks up.
 */
import type { Locator } from 'playwright-core'

export async function fillTextarea(locator: Locator, text: string): Promise<void> {
  await locator.evaluate((el: HTMLTextAreaElement, value: string) => {
    // Use the native property setter so frameworks that intercept assignment see the change
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set
    if (nativeSetter) {
      nativeSetter.call(el, value)
    } else {
      el.value = value
    }
    // Vue 3 v-model listens to 'input'; dispatch both to cover any variant
    el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }, text)
}
