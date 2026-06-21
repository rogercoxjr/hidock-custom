import { cn } from '@/lib/utils'

// Deterministic Harbor-friendly avatar colors (used when no explicit color given).
const AVATAR_COLORS = [
  'var(--blue-600)',
  'var(--brand-teal)',
  'var(--blue-500)',
  'var(--amber-600)',
  'var(--green-600)',
  'var(--coral-600)',
  'var(--blue-800)'
]

export function avatarColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

interface PersonAvatarProps {
  name: string
  /** Override the deterministic color (e.g. a contact's assigned color). */
  color?: string
  /** Pixel diameter. Default 30. */
  size?: number
  className?: string
}

/**
 * Harbor avatar — initials on a colored disc. Reused in People, transcript
 * speaker rows, SpeakerAssign, and suggestion chips.
 */
export function PersonAvatar({ name, color, size = 30, className }: PersonAvatarProps) {
  const bg = color ?? avatarColor(name)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
        className
      )}
      style={{ width: size, height: size, background: bg, fontSize: Math.max(9, Math.round(size * 0.38)) }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  )
}
