"use client"

import * as React from "react"

type Theme = "light" | "dark" | "system"
type ResolvedTheme = "light" | "dark"

type ThemeProviderProps = {
  children: React.ReactNode
  defaultTheme?: Theme
  storageKey?: string
}

type ThemeProviderState = {
  theme: Theme
  resolvedTheme: ResolvedTheme
  systemTheme: ResolvedTheme
  themes: Theme[]
  setTheme: (theme: Theme) => void
}

const ThemeProviderContext = React.createContext<ThemeProviderState>({
  theme: "system",
  resolvedTheme: "light",
  systemTheme: "light",
  themes: ["light", "dark", "system"],
  setTheme: () => null,
})

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light"
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function applyTheme(theme: Theme, systemTheme: ResolvedTheme) {
  const resolvedTheme = theme === "system" ? systemTheme : theme
  const root = document.documentElement
  root.classList.toggle("dark", resolvedTheme === "dark")
  root.style.colorScheme = resolvedTheme
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = "theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = React.useState<Theme>(defaultTheme)
  const [systemTheme, setSystemTheme] = React.useState<ResolvedTheme>("light")

  React.useEffect(() => {
    const storedTheme = window.localStorage.getItem(storageKey) as Theme | null
    const nextTheme =
      storedTheme === "light" || storedTheme === "dark" || storedTheme === "system"
        ? storedTheme
        : defaultTheme

    setThemeState(nextTheme)
    setSystemTheme(getSystemTheme())
  }, [defaultTheme, storageKey])

  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => setSystemTheme(getSystemTheme())

    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  React.useEffect(() => {
    applyTheme(theme, systemTheme)
  }, [theme, systemTheme])

  const setTheme = React.useCallback((nextTheme: Theme) => {
    window.localStorage.setItem(storageKey, nextTheme)
    setThemeState(nextTheme)
  }, [storageKey])

  const value = React.useMemo<ThemeProviderState>(() => ({
    theme,
    resolvedTheme: theme === "system" ? systemTheme : theme,
    systemTheme,
    themes: ["light", "dark", "system"],
    setTheme,
  }), [theme, systemTheme, setTheme])

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export function useTheme() {
  return React.useContext(ThemeProviderContext)
}
