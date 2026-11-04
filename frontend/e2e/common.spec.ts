import { expect, test } from "@playwright/test"

test.describe("diagnostics dashboard", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("connects to the stream and shows the simulated device", async ({ page }) => {
    await expect(page.getByTestId("sse")).toHaveText("SSE live")
    await expect(page.getByTestId("state")).toContainText("streaming")
    await expect(page.getByTestId("simulated")).toBeVisible()
    await expect(page.getByTestId("device-config")).toContainText("4.5.74")
  })

  test("renders every chart with Plotly", async ({ page }) => {
    for (const metric of ["power", "cadence", "speed", "gap"]) {
      const chart = page.getByTestId(`chart-${metric}`)
      await expect(chart.locator(".main-svg").first()).toBeVisible()
      await expect(chart.locator(".scatterlayer .trace").first()).toBeAttached()
    }
  })

  test("reference crank meter always reports power", async ({ page }) => {
    await expect
      .poll(async () => Number(await page.getByTestId("value-power-pm_crank").textContent()))
      .toBeGreaterThan(100)
  })

  test("raw feed shows all four sources and filters by source", async ({ page }) => {
    const feed = page.getByTestId("raw-feed")
    for (const src of ["cps", "ftms", "ant_fe", "pm_crank"]) {
      await expect(feed.locator(`tr[data-src="${src}"]`).first()).toBeAttached()
    }
    await page.getByTestId("raw-filter").click()
    await page.getByRole("option", { name: "pm_crank" }).click()
    await expect(feed.locator("tbody tr").first()).toHaveAttribute("data-src", "pm_crank")
    await expect(feed.locator('tbody tr:not([data-src="pm_crank"])')).toHaveCount(0)
  })

  test("pause freezes the raw feed", async ({ page }) => {
    const first = page.getByTestId("raw-feed").locator("tbody tr").first()
    await expect(first).toBeAttached()
    await page.getByTestId("raw-pause").click()
    const frozen = await first.textContent()
    await page.waitForTimeout(1500)
    expect(await first.textContent()).toBe(frozen)
    await page.getByTestId("raw-pause").click()
    await expect.poll(() => first.textContent()).not.toBe(frozen)
  })

  test("theme toggle switches between dark and light", async ({ page }) => {
    const html = page.locator("html")
    await expect(html).toHaveClass(/dark/)
    await page.getByTestId("theme-toggle").click()
    await expect(html).toHaveClass(/light/)
    await page.getByTestId("theme-toggle").click()
    await expect(html).toHaveClass(/dark/)
  })

  test("navigates to the virtual route", async ({ page }) => {
    await page.getByRole("link", { name: "Virtual route" }).click()
    await expect(page).toHaveURL(/\/route$/)
    await expect(page.getByTestId("route-scene").locator("canvas")).toBeVisible()
  })
})
