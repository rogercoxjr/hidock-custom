import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import './styles/fonts.css'
import './index.css'

// ---------------------------------------------------------------------------
// REST SDK bootstrap (Phase 0e)
//
// Install the REST/WS SDK as window.electronAPI BEFORE the React tree mounts
// so every component that reads window.electronAPI sees the REST SDK from the
// very first render.  The Electron preload bridge remains active for the
// desktop path; this block is a no-op when window.electronAPI is already set
// by the preload (desktop Electron) — the preload assigns to window first,
// and `installRestApi` checks `typeof window !== 'undefined'` before
// overwriting.
//
// For the hosted (browser) path:
//   - `installRestApi()` builds the API object, connects the WsClient,
//     and assigns it to window.electronAPI.
//   - `setOnUnauthorized` wires the 401 redirect to the 0b login route.
// ---------------------------------------------------------------------------

// Only run the REST SDK bootstrap in the hosted path (no Electron preload).
// The preload sets window.electronAPI synchronously before the renderer script
// runs, so if it is already present we leave it intact (desktop mode).
if (!(window as any).electronAPI) {
  // Lazy-import to avoid pulling the REST SDK into Electron's renderer bundle
  // when the preload already owns the API surface.
  const { installRestApi, setOnUnauthorized } = await import('./lib/electron-api')

  // Wire 401 → redirect to the 0b OIDC login page.
  setOnUnauthorized(() => {
    window.location.href = '/auth/login'
  })

  installRestApi()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
    <App />
  </HashRouter>
)
