// Print browser console errors for a page. Usage: node e2e/console.mjs http://127.0.0.1:8766/
import { chromium } from "@playwright/test"

const url = process.argv[2] ?? "http://127.0.0.1:8765/"
const browser = await chromium.launch()
const page = await browser.newPage()
page.on("console", (m) => m.type() === "error" && console.log("console:", m.text()))
page.on("pageerror", (e) => console.log("pageerror:", e.message, "\n", e.stack?.split("\n").slice(0, 4).join("\n")))
await page.goto(url)
await page.waitForTimeout(4000)
await browser.close()
