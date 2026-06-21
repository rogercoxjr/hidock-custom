/// <reference types="vite/client" />

interface AudioControls {
  play: (recordingId: string, filePath: string, startTimeSeconds?: number) => void
  pause: () => void
  resume: () => void
  stop: () => void
  seek: (time: number) => void
  setPlaybackRate: (rate: number) => void
  loadWaveformOnly: (recordingId: string, filePath: string) => void
}

interface Window {
  __audioControls?: AudioControls
}
