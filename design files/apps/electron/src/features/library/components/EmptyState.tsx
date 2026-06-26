import { Mic, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

interface EmptyStateProps {
  hasRecordings: boolean
  onNavigateToDevice: () => void
  onAddRecording: () => void
}

export function EmptyState({ hasRecordings, onNavigateToDevice, onAddRecording }: EmptyStateProps) {
  return (
    <Card>
      <CardContent className="py-16 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-xl bg-surface-sunken text-accent-2">
          <Mic className="h-6 w-6" />
        </div>
        {!hasRecordings ? (
          <>
            <h3 className="font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink mb-2">
              No Knowledge Captured Yet
            </h3>
            <p className="text-ink-muted mb-4">
              Connect your HiDock device to sync your captured conversations, or import audio files from your computer.
            </p>
            <div className="flex gap-2 justify-center">
              <Button onClick={onNavigateToDevice}>Go to Device</Button>
              <Button variant="outline" onClick={onAddRecording}>
                <Plus className="h-4 w-4 mr-2" />
                Import File
              </Button>
            </div>
          </>
        ) : (
          <>
            <h3 className="font-display text-[1.375rem] font-semibold tracking-[-0.01em] text-ink mb-2">
              No Matching Captures
            </h3>
            <p className="text-ink-muted">Try changing your filter or search query.</p>
          </>
        )}
      </CardContent>
    </Card>
  )
}
