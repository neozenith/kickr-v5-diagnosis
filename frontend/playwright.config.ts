import { defineConfig, devices } from "@playwright/test"

// Each project runs against its own service instance driven by the simulated driver (sim.py).
// The services serve frontend/dist, so build first: `make test-e2e` does both.
const PORTS = { healthy: 8771, faulty: 8772 } as const
const root = new URL("..", import.meta.url).pathname

export default defineConfig({
  testDir: "./e2e",
  outputDir: "../tmp/playwright/results",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [["list"], ["html", { outputFolder: "../tmp/playwright/report", open: "never" }]],
  use: { ...devices["Desktop Chrome"], trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "healthy", testMatch: /(healthy|common|route)\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${PORTS.healthy}` } },
    { name: "faulty", testMatch: /(faulty|common)\.spec\.ts/, use: { baseURL: `http://127.0.0.1:${PORTS.faulty}` } },
  ],
  webServer: Object.entries(PORTS).map(([scenario, port]) => ({
    command: `uv run service.py --sim ${scenario} --port ${port}`,
    cwd: root,
    url: `http://127.0.0.1:${port}/api/status`,
    reuseExistingServer: false,
    timeout: 60_000,
  })),
})
