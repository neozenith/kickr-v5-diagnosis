import { expect, test } from "@playwright/test"

// Simulated KICKR 9B08 fault: above 12 km/h the trainer's wheel counter freezes.
test.describe("faulty trainer", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/")
  })

  test("flags a sensor fault against the reference", async ({ page }) => {
    const verdict = page.getByTestId("diagnosis")
    await expect(verdict).toHaveAttribute("data-verdict", "fault")
    await expect(verdict).toContainText("Trainer sensor fault")
  })

  test("watchdog reports frozen CPS counters", async ({ page }) => {
    await expect(page.getByTestId("stalled").filter({ hasText: "cps.wheel.counter" })).toBeVisible()
    await expect(page.getByTestId("events")).toContainText("FROZEN: cps.wheel counter")
  })

  test("trainer reads 0 W while the reference reads real power", async ({ page }) => {
    await expect
      .poll(async () => Number(await page.getByTestId("value-power-pm_crank").textContent()))
      .toBeGreaterThan(100)
    await expect(page.getByTestId("value-power-ftms")).toHaveText("0")
  })

  test("ANT+ reports power calibration required", async ({ page }) => {
    await expect(page.getByTestId("ant-status")).toContainText("YES")
  })

  test("spindown never reaches target speed", async ({ page }) => {
    await page.getByRole("button", { name: "Spindown" }).click()
    await expect(page.getByTestId("calibration-request")).toContainText("spindown requested")
    const pages = page.getByTestId("calibration-pages")
    await expect(pages).toContainText("in progress")
    await expect(pages).toContainText("too_low")
    await expect(pages).toContainText("32.1")
  })
})
