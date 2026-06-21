/** @type {import('tailwindcss').Config} */

// Harbor colors are full color values (hex / var / color-mix), not HSL channels.
// To keep Tailwind opacity modifiers working (e.g. bg-muted/50, hover:bg-primary/90),
// wrap each color so the `<alpha-value>` placeholder is honored via color-mix.
// At 100% (the default for non-opacity utilities) color-mix returns the color unchanged.
const c = (v) => `color-mix(in srgb, ${v} calc(<alpha-value> * 100%), transparent)`

module.exports = {
  darkMode: ['class'],
  content: ['./src/**/*.{js,jsx,ts,tsx}', './src/index.html'],
  theme: {
    extend: {
      colors: {
        // ---- shadcn/Radix families (resolve to Harbor via the index.css bridge) ----
        border: c('var(--border)'),
        input: c('var(--input)'),
        ring: c('var(--ring)'),
        background: c('var(--background)'),
        foreground: c('var(--foreground)'),
        primary: {
          DEFAULT: c('var(--primary)'),
          foreground: c('var(--primary-foreground)')
        },
        secondary: {
          DEFAULT: c('var(--secondary)'),
          foreground: c('var(--secondary-foreground)')
        },
        destructive: {
          DEFAULT: c('var(--destructive)'),
          foreground: c('var(--destructive-foreground)')
        },
        muted: {
          DEFAULT: c('var(--muted)'),
          foreground: c('var(--muted-foreground)')
        },
        accent: {
          // shadcn's subtle hover bg → --ui-accent (does NOT collide with Harbor --accent)
          DEFAULT: c('var(--ui-accent)'),
          foreground: c('var(--ui-accent-foreground)')
        },
        popover: {
          DEFAULT: c('var(--popover)'),
          foreground: c('var(--popover-foreground)')
        },
        card: {
          DEFAULT: c('var(--card)'),
          foreground: c('var(--card-foreground)')
        },

        // ---- Harbor semantic additions (ergonomic aliases for new components) ----
        bg: {
          DEFAULT: c('var(--bg)'),
          sunken: c('var(--bg-sunken)')
        },
        surface: {
          DEFAULT: c('var(--surface)'),
          raised: c('var(--surface-raised)'),
          hover: c('var(--surface-hover)'),
          sunken: c('var(--surface-sunken)')
        },
        ink: {
          DEFAULT: c('var(--text-strong)'),
          muted: c('var(--text-muted)'),
          body: c('var(--text)')
        },
        'border-strong': c('var(--border-strong)'),
        'border-brand': c('var(--border-brand)'),
        brand: {
          navy: c('var(--brand-navy)'),
          teal: c('var(--brand-teal)')
        },
        // Harbor primary blue + variants (distinct from shadcn `accent`)
        'accent-strong': {
          DEFAULT: c('var(--accent)'),
          hover: c('var(--accent-hover)'),
          soft: c('var(--accent-soft)')
        },
        // Harbor secondary accent (logo teal)
        'accent-2': {
          DEFAULT: c('var(--accent-2)'),
          hover: c('var(--accent-2-hover)'),
          soft: c('var(--accent-2-soft)')
        },
        success: {
          DEFAULT: c('var(--success)'),
          soft: c('var(--success-soft)')
        },
        warning: {
          DEFAULT: c('var(--warning)'),
          soft: c('var(--warning-soft)')
        },
        danger: {
          DEFAULT: c('var(--danger)'),
          soft: c('var(--danger-soft)')
        }
      },
      fontFamily: {
        sans: ['var(--font-sans)'],
        display: ['var(--font-display)'],
        mono: ['var(--font-mono)']
      },
      boxShadow: {
        xs: 'var(--shadow-xs)',
        sm: 'var(--shadow-sm)',
        DEFAULT: 'var(--shadow-sm)',
        md: 'var(--shadow-md)',
        lg: 'var(--shadow-lg)',
        xl: 'var(--shadow-xl)'
      },
      borderRadius: {
        none: '0',
        xs: 'var(--radius-xs)',
        sm: 'var(--radius-sm)',
        DEFAULT: 'var(--radius-md)',
        md: 'var(--radius-md)',
        lg: 'var(--radius-lg)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full: 'var(--radius-full)'
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        'in-out': 'var(--ease-in-out)',
        spring: 'var(--ease-spring)'
      }
    }
  },
  plugins: [
    require('tailwindcss-animate'),
    require('@tailwindcss/container-queries')
  ]
}
