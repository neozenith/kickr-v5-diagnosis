import { expect, test } from "@playwright/test"

test.describe("healthy trainer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("trainer agrees with the reference", async ({ page }) => {
    await expect
      .poll(async () => Number(await page.getByTestId("value-power-ftms").textContent()))
      .toBeGreaterThan(100)
    await expect(page.getByTestId("diagnosis")).toHaveAttribute("data-verdict", "ok")
    await expect(page.getByTestId("stalled")).toHaveCount(0)
  })

  test("all trainer channels report speed", async ({ page }) => {
    for (const src of ["cps", "ftms", "ant_fe"]) {
      await expect
        .poll(async () => Number(await page.getByTestId(`value-speed-${src}`).textContent()))
        .toBeGreaterThan(10)
    }
  })

  test("spindown completes with a result page", async ({ page }) => {
    await page.getByRole("button", { name: "Spindown" }).click()
    await expect(page.getByTestId("calibration-pages")).toContainText("RESULT", { timeout: 50_000 })
    await expect(page.getByTestId("calibration-pages")).toContainText("cal_spindown_ok")
  })
})
