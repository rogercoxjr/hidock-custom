/**
 * QuickAddContact — reusable inline create dialog wrapping contacts:create.
 * Used by People.tsx; SpeakersPanel inlines its own variant.
 */

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'

interface QuickAddContactProps {
  open: boolean
  onClose: () => void
  onCreated: (contact: { id: string; name: string; email: string | null }) => void
}

export function QuickAddContact({ open, onClose, onCreated }: QuickAddContactProps) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  if (!open) return null

  async function create() {
    const trimmed = name.trim()
    if (!trimmed) {
      toast.error('Name is required')
      return
    }
    setBusy(true)
    try {
      const res = await (window as any).electronAPI.contacts.create({
        name: trimmed,
        email: email.trim() || null,
      })
      if (res?.success && res.data) {
        onCreated(res.data)
        setName('')
        setEmail('')
        onClose()
      } else {
        toast.error('Could not create contact', res?.error?.message)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div className="w-80 p-4 bg-background rounded-lg border space-y-3">
        <h3 className="text-sm font-semibold">Add Person</h3>
        <Input
          aria-label="Name"
          placeholder="Name (required)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={busy}
        />
        <Input
          aria-label="Email"
          placeholder="Email (optional)"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={busy}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={create} disabled={busy}>Create</Button>
        </div>
      </div>
    </div>
  )
}
