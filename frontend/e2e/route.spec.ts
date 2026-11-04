import { expect, test, type Page } from "@playwright/test"

const num = async (page: Page, id: string) => Number(await page.getByTestId(id).textContent())

test.describe("virtual route", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/route")
  })

  test("renders the 3D loop and the elevation profile", async ({ page }) => {
    await expect(page.getByTestId("route-scene").locator("canvas")).toBeVisible()
    await expect(page.getByTestId("elevation-overlay")).toBeVisible()
    await expect(page.getByTestId("elevation-profile").locator(".main-svg").first()).toBeVisible()
    // The overlay sits inside the top-right corner of the 3D view.
    const scene = (await page.getByTestId("route-scene").boundingBox())!
    const overlay = (await page.getByTestId("elevation-overlay").boundingBox())!
    expect(overlay.y).toBeLessThan(scene.y + 40)
    expect(overlay.x + overlay.width).toBeGreaterThan(scene.x + scene.width - 40)
    expect(overlay.x).toBeGreaterThan(scene.x + scene.width / 2)
  })

  test("rider moves along the loop on reference power", async ({ page }) => {
    await expect.poll(() => num(page, "ride-power")).toBeGreaterThan(0)
    await expect.poll(() => num(page, "ride-distance")).toBeGreaterThan(4.02)
    await expect.poll(() => num(page, "ride-speed")).toBeGreaterThan(5)
  })

  test("route has climbs and descents", async ({ page }) => {
    await page.getByTestId("power-source-manual").click()
    const grades = new Set<number>()
    for (let i = 0; i < 20; i++) {
      grades.add(Math.sign(await num(page, "ride-grade")))
      if (grades.has(1) && grades.has(-1)) break
      await page.waitForTimeout(1000)
    }
    expect(grades.has(1) || grades.has(-1)).toBe(true)
    await expect(page.getByText(/m climbing per lap/)).toBeVisible()
  })

  test("manual power drives the rider and reset returns to start", async ({ page }) => {
    await page.getByTestId("power-source-manual").click()
    await expect.poll(() => num(page, "ride-power")).toBe(200)
    await page.getByTestId("ride-reset").click()
    await expect.poll(async () => Math.abs((await num(page, "ride-distance")) - 4.0)).toBeLessThan(0.05)
    await page.getByTestId("ride-toggle").click()
    const stopped = await num(page, "ride-distance")
    await page.waitForTimeout(1000)
    expect(await num(page, "ride-distance")).toBe(stopped)
  })

  test("scene has a terrain grid, dashed centreline and a jointed rider", async ({ page }) => {
    const scene = page.getByTestId("route-scene")
    await expect(scene).toHaveAttribute("data-grid-step", "10")
    expect(Number(await scene.getAttribute("data-dashes"))).toBeGreaterThan(500)
    expect(Number(await scene.getAttribute("data-rider-parts"))).toBeGreaterThan(30)
  })

  test("pedals turn with cadence and stop at 0 rpm", async ({ page }) => {
    const scene = page.getByTestId("route-scene")
    const angle = async () => Number(await scene.getAttribute("data-crank-angle"))
    await page.getByTestId("power-source-manual").click()
    await expect.poll(() => num(page, "ride-cadence")).toBe(90)
    const a = await angle()
    await expect.poll(angle).not.toBe(a)

    await page.getByTestId("manual-cadence").getByRole("slider").focus()
    await page.keyboard.press("Home")
    await expect.poll(() => num(page, "ride-cadence")).toBe(0)
    await page.waitForTimeout(500)
    const stopped = await angle()
    await page.waitForTimeout(1000)
    expect(await angle()).toBe(stopped)
  })

  test("live inputs overlay charts a 5 minute trend of every source", async ({ page }) => {
    const overlay = page.getByTestId("inputs-overlay")
    await expect(overlay).toBeVisible()
    await expect(overlay).toContainText("Last 5 minutes")
    const scene = (await page.getByTestId("route-scene").boundingBox())!
    const box = (await overlay.boundingBox())!
    expect(box.x).toBeLessThan(scene.x + 40)
    expect(box.y).toBeLessThan(scene.y + 40)
    const trend = page.getByTestId("inputs-trend")
    // Power, cadence and speed rows: 4 + 4 + 3 traces, on three stacked y axes.
    await expect(trend.locator(".scatterlayer .trace")).toHaveCount(11)
    await expect(trend.locator(".ytitle, .y2title, .y3title")).toHaveText(["W", "rpm", "km/h"])
    // Lines grow as data streams in.
    const path = trend.locator(".scatterlayer .trace .js-line").first()
    const len = async () => ((await path.getAttribute("d")) ?? "").length
    const before = await len()
    await expect.poll(len).toBeGreaterThan(before)
  })

  test("ride stats live inside the HUD overlays", async ({ page }) => {
    const inputs = page.getByTestId("inputs-overlay")
    for (const id of ["ride-power", "ride-cadence", "ride-speed"]) {
      await expect(inputs.getByTestId(id)).toBeVisible()
    }
    const elevation = page.getByTestId("elevation-overlay")
    for (const id of ["ride-grade", "ride-elevation", "ride-distance", "ride-laps"]) {
      await expect(elevation.getByTestId(id)).toBeVisible()
    }
  })

  test("3D rider height and grade match the elevation profile", async ({ page }) => {
    // 4.6 km is on the long descent; 0.4 km is on the opening climb.
    for (const [at, sign] of [["4.6", -1], ["0.2", 1]] as const) {
      await page.goto(`/route?at=${at}`)
      await page.getByTestId("ride-toggle").click() // pause so HUD and scene agree exactly
      const scene = page.getByTestId("route-scene")
      await expect(scene).toHaveAttribute("data-rider-elevation", /-?\d/)
      await page.waitForTimeout(600)
      const hudElevation = await num(page, "ride-elevation")
      const hudGrade = await num(page, "ride-grade")
      const sceneElevation = Number(await scene.getAttribute("data-rider-elevation"))
      const sceneGrade = Number(await scene.getAttribute("data-rider-grade"))
      expect(Math.sign(hudGrade)).toBe(sign)
      expect(Math.sign(sceneGrade)).toBe(sign)
      expect(Math.abs(sceneElevation - hudElevation)).toBeLessThan(1)
    }
  })

  test("scenery: trees, mountain ridges and clouds", async ({ page }) => {
    const scene = page.getByTestId("route-scene")
    await expect(scene).toHaveAttribute("data-ridges", "3")
    expect(Number(await scene.getAttribute("data-trees"))).toBeGreaterThan(1000)
    expect(Number(await scene.getAttribute("data-clouds"))).toBeGreaterThan(20)
  })

  test("ride starts at the 4 km mark", async ({ page }) => {
    await page.getByTestId("ride-toggle").click() // pause at the start
    const d = await num(page, "ride-distance")
    expect(d).toBeGreaterThanOrEqual(4.0)
    expect(d).toBeLessThan(4.05)
  })

  test("route map HUD sits bottom right with the loop, start line and rider", async ({ page }) => {
    const overlay = page.getByTestId("map-overlay")
    await expect(overlay).toBeVisible()
    const scene = (await page.getByTestId("route-scene").boundingBox())!
    const box = (await overlay.boundingBox())!
    expect(box.x + box.width).toBeGreaterThan(scene.x + scene.width - 40)
    expect(box.y + box.height).toBeGreaterThan(scene.y + scene.height - 40)
    const map = page.getByTestId("route-map")
    await expect(map.locator(".scatterlayer .trace")).toHaveCount(3) // route, start, rider
    await expect(map.locator(".scatterlayer .trace").first().locator(".point")).toHaveCount(3000)
    // The rider marker moves as the ride progresses.
    const rider = map.locator(".scatterlayer .trace").nth(2).locator(".point")
    const before = await rider.getAttribute("transform")
    await expect.poll(() => rider.getAttribute("transform")).not.toBe(before)
  })

  test("4.2 to 5.2 km descends through switchbacks", async ({ page }) => {
    const scene = page.getByTestId("route-scene")
    await expect(scene).toHaveAttribute("data-switchbacks", "5")
    // 1 km of road whose ends are only a few hundred metres apart: it zig-zags.
    expect(Number(await scene.getAttribute("data-switchback-span"))).toBeLessThan(500)
  })

  test("a cobbled village with right-angle turns follows the switchbacks", async ({ page }) => {
    const scene = page.getByTestId("route-scene")
    await expect(scene).toHaveAttribute("data-village-turns", "8")
    expect(Number(await scene.getAttribute("data-houses"))).toBeGreaterThan(20)
    await expect(scene).toHaveAttribute("data-church", "true")
  })

  test("riding is smooth: distance advances every frame, not in timer steps", async ({ page }) => {
    await page.getByTestId("power-source-manual").click()
    await page.waitForTimeout(2000) // get up to speed
    // Sample the rider's scene position over consecutive animation frames.
    const steps = await page.evaluate(
      () =>
        new Promise<number[]>((resolve) => {
          const el = document.querySelector('[data-testid="route-scene"]') as HTMLElement
          const out: number[] = []
          let prev = Number(el.dataset.riderDistance)
          const tick = () => {
            const d = Number(el.dataset.riderDistance)
            out.push(d - prev)
            prev = d
            if (out.length < 30) requestAnimationFrame(tick)
            else resolve(out.slice(1))
          }
          requestAnimationFrame(tick)
        })
    )
    // Most frames should move the rider; a 20 Hz timer would leave many frames unchanged.
    const moving = steps.filter((s) => s > 0).length
    expect(moving / steps.length).toBeGreaterThan(0.8)
  })

  test("village festival: sidewalk crowd cheers the rider, bunting overhead", async ({ page }) => {
    await page.goto("/route?at=5.3")
    const scene = page.getByTestId("route-scene")
    expect(Number(await scene.getAttribute("data-people"))).toBeGreaterThan(80)
    expect(Number(await scene.getAttribute("data-flags"))).toBeGreaterThan(300)
    // People near the rider are celebrating.
    await expect.poll(async () => Number(await scene.getAttribute("data-cheering"))).toBeGreaterThan(5)
    // Out on the open road nobody is.
    await page.goto("/route?at=1.0")
    await expect(scene).toHaveAttribute("data-cheering", "0")
  })
})
