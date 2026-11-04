// Record a video of the virtual route: the switchback descent from 4 km, then the village.
// Usage: node e2e/record-route.mjs http://127.0.0.1:8766 ../tmp/recordings
import { mkdirSync, renameSync } from "node:fs"
import { chromium } from "@playwright/test"

const [base = "http://127.0.0.1:8765", out = "../tmp/recordings"] = process.argv.slice(2)
const size = { width: 1440, height: 900 }
mkdirSync(out, { recursive: true })

// GPU rendering in headless Chrome on macOS; software rendering is too slow for smooth video.
const browser = await chromium.launch({ args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] })
const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } })
const page = await context.newPage()

await page.goto(base + "/route?at=4.0")
const scene = page.getByTestId("route-scene")
await scene.locator("canvas").waitFor()

// Measure render rate, so the log says whether the video will be smooth.
const fps = await page.evaluate(
  () =>
    new Promise((resolve) => {
      let n = 0
      const t0 = performance.now()
      const tick = () => (++n, performance.now() - t0 < 2000 ? requestAnimationFrame(tick) : resolve(n / 2))
      requestAnimationFrame(tick)
    })
)
console.log(`render rate ${fps} fps, renderer`, await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2")
  const ext = gl?.getExtension("WEBGL_debug_renderer_info")
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown"
}))

// Manual power at the top of the slider, brisk cadence, then ride.
await page.getByTestId("power-source-manual").click()
await page.getByTestId("manual-power").getByRole("slider").focus()
await page.keyboard.press("End")
await page.getByTestId("manual-cadence").getByRole("slider").focus()
for (let i = 0; i < 2; i++) await page.keyboard.press("ArrowRight")
await page.mouse.move(size.width / 2, size.height - 20) // keep the pointer off the scene

const villageEnd = await scene.evaluate((el) => Number(el.dataset.villageFrom) + 0.65)
const deadline = Date.now() + 6 * 60_000
while (Date.now() < deadline) {
  const d = Number(await page.getByTestId("ride-distance").textContent())
  if (d >= villageEnd) break
  await page.waitForTimeout(1000)
}
await page.waitForTimeout(2000)
const video = page.video()
await context.close()
const path = `${out}/switchbacks-and-village.webm`
renameSync(await video.path(), path)
await browser.close()
console.log(`saved ${path}`)
