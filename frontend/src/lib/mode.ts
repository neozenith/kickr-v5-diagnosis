import { useTheme } from "@/components/theme-provider"

export type Mode = "light" | "dark"

/** The light/dark mode actually applied, resolving "system" from the OS preference. */
export function useResolvedMode(): Mode {
  const { theme } = useTheme()
  if (theme === "system") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  return theme
}
