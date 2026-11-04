import { lazy, Suspense } from "react"
import { BrowserRouter, NavLink, Route, Routes } from "react-router"
import { Skeleton } from "@/components/ui/skeleton"
import { MoonIcon, SunIcon } from "lucide-react"

import { useTheme } from "@/components/theme-provider"
import { cn } from "cn"

import { useResolvedMode } from "@/lib/mode"
import { Button, buttonVariants } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

const DashboardPage = lazy(() => import("@/pages/dashboard").then((m) => ({ default: m.DashboardPage })))
const RoutePage = lazy(() => import("@/pages/route").then((m) => ({ default: m.RoutePage })))

const NAV = [
  { to: "/", label: "Diagnostics" },
  { to: "/route", label: "Virtual route" },
]

function Header() {
  const { theme, setTheme } = useTheme()
  const dark = useResolvedMode() === "dark"
  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center gap-4">
        <h1 className="font-heading text-2xl font-semibold">KICKR v5 diagnostics</h1>
        <nav className="flex gap-1" aria-label="Pages">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end
              className={cn(
                buttonVariants({ variant: "ghost", size: "sm" }),
                "aria-[current=page]:bg-secondary aria-[current=page]:text-secondary-foreground"
              )}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <Button
          className="ml-auto"
          variant="ghost"
          size="icon-sm"
          aria-label={`Switch to ${dark ? "light" : "dark"} mode (current: ${theme})`}
          data-testid="theme-toggle"
          onClick={() => setTheme(dark ? "light" : "dark")}
        >
          {dark ? <SunIcon /> : <MoonIcon />}
        </Button>
      </div>
      <Separator />
    </header>
  )
}

export function App() {
  return (
    <BrowserRouter>
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4 p-4">
        <Header />
        <Suspense fallback={<Skeleton className="h-96 w-full" />}>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/route" element={<RoutePage />} />
          </Routes>
        </Suspense>
      </div>
    </BrowserRouter>
  )
}

export default App
