// Capture dashboard and route screenshots from a running service.
// Usage: node e2e/screenshots.mjs http://127.0.0.1:8766 ../tmp/screenshots
import { mkdirSync } from "node:fs"
import { chromium } from "@playwright/test"

const [base = "http://127.0.0.1:8765", out = "../tmp/screenshots"] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
await page.goto(base + "/")
await page.waitForTimeout(12000)
await page.screenshot({ path: `${out}/dashboard.png`, fullPage: true })
await page.goto(base + "/route")
await page.waitForTimeout(8000)
await page.screenshot({ path: `${out}/route.png`, fullPage: true })
await page.goto(base + "/route?at=4.47")
await page.waitForTimeout(6000)
await page.screenshot({ path: `${out}/route-descent.png`, fullPage: true })
const villageAt = await page.getByTestId("route-scene").getAttribute("data-village-from")
await page.goto(base + `/route?at=${Number(villageAt) + 0.12}`)
await page.waitForTimeout(6000)
await page.screenshot({ path: `${out}/route-village.png`, fullPage: true })
await browser.close()
console.log(`saved ${out}/dashboard.png and ${out}/route.png`)
