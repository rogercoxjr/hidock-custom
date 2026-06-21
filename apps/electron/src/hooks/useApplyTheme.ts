import { useEffect } from 'react'
import { useUIStore } from '@/store/ui/useUIStore'

/**
 * Applies the Harbor theme to the document root.
 *
 * Resolves `theme` ('light' | 'dark' | 'system') from useUIStore and toggles the
 * `.dark` class on <html> (Tailwind darkMode: ['class']). When 'system', it
 * follows the OS color-scheme and updates live as that preference changes.
 *
 * Light is the default; dark tokens exist in index.css and activate via this hook.
 */
export function useApplyTheme(): void {
  const theme = useUIStore((s) => s.theme)

  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = () => {
      const isDark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', isDark)
    }

    apply()

    // Listener only changes anything when theme === 'system' (apply() ignores
    // media for fixed themes), but attaching unconditionally keeps return paths
    // consistent and is harmless.
    media.addEventListener('change', apply)
    return () => media.removeEventListener('change', apply)
  }, [theme])
}
