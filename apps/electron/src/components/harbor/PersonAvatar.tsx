import { AudioWaveform } from 'lucide-react'
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
  /**
   * When true, renders a small teal voiceprint pip (bottom-right badge)
   * indicating an enrolled voiceprint exists for this contact.
   * Default false — existing call sites are unaffected.
   */
  voiceBadge?: boolean
}

/**
 * Harbor avatar — initials on a colored disc. Reused in People, transcript
 * speaker rows, SpeakerAssign, and suggestion chips.
 *
 * voiceBadge=true adds a teal AudioWaveform pip bottom-right. The pip's
 * accessible title sits outside the aria-hidden initials span so screen
 * readers can discover it.
 */
export function PersonAvatar({ name, color, size = 30, className, voiceBadge = false }: PersonAvatarProps) {
  const base = color ?? avatarColor(name)
  // Tonal Harbor avatar: a pale tint of the person's hue with dark same-hue initials.
  // Keeps per-person hue (and harmonizes with the saturated speaker dots that reuse avatarColor),
  // but reads calm/on-brand instead of a saturated fill with white text.
  const bg = `color-mix(in srgb, ${base} 22%, white)`
  const fg = `color-mix(in srgb, ${base} 72%, black)`
  const pipSize = Math.max(10, Math.round(size * 0.38))

  return (
    <span className={cn('relative inline-flex shrink-0 overflow-visible', className)}>
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
        style={{ width: size, height: size, background: bg, color: fg, fontSize: Math.max(9, Math.round(size * 0.38)) }}
        aria-hidden
      >
        {initialsOf(name)}
      </span>
      {voiceBadge && (
        <span
          className="absolute bottom-0 right-0 flex items-center justify-center rounded-full bg-accent-2 text-white ring-2 ring-surface"
          style={{ width: pipSize, height: pipSize, transform: 'translate(25%, 25%)' }}
          title="Has enrolled voiceprint"
          aria-label="Has enrolled voiceprint"
        >
          <AudioWaveform style={{ width: pipSize * 0.6, height: pipSize * 0.6 }} />
        </span>
      )}
    </span>
  )
}
