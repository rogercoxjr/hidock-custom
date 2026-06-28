/**
 * http.ts — fetch transport for the renderer REST SDK.
 *
 * A thin wrapper around `fetch` that:
 * - Resolves the base URL from `import.meta.env.VITE_API_BASE_URL` or `window.location.origin`.
 * - Always sends `credentials: 'include'` (session cookie auth from 0b).
 * - JSON-encodes the body on non-GET requests and sets `Content-Type: application/json`.
 * - Normalises every outcome to `HttpResult` — never rejects; adapters choose throw-vs-Result.
 * - Fires `onUnauthorized` on 401 (inject a redirect to the 0b login page at bootstrap).
 *
 * Deliberately has NO knowledge of per-method return shapes — those belong to group adapters.
 */

export interface HttpResult {
  ok: boolean
  status: number
  data?: unknown
  error?: string
}

type OnUnauthorized = (() => void) | undefined

let _onUnauthorized: OnUnauthorized

/** Inject the 401 redirect hook at bootstrap (e.g. → 0b login URL). */
export function setOnUnauthorized(handler: OnUnauthorized): void {
  _onUnauthorized = handler
}

function baseUrl(): string {
  // Vite env var takes precedence (useful for cross-origin dev proxy), falls back to same-origin.
  const envBase = (import.meta as Record<string, any>).env?.VITE_API_BASE_URL
  if (envBase) return envBase.replace(/\/$/, '')
  if (typeof window !== 'undefined') return window.location.origin
  return ''
}

async function request(method: string, path: string, body?: unknown): Promise<HttpResult> {
  const url = `${baseUrl()}${path}`
  const isWrite = method !== 'GET'

  const headers: Record<string, string> = {}
  if (isWrite && body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }

  const init: RequestInit = {
    method,
    credentials: 'include',
    headers,
  }
  if (isWrite && body !== undefined) {
    init.body = JSON.stringify(body)
  }

  try {
    const response = await fetch(url, init)
    const { status } = response

    if (status === 401) {
      _onUnauthorized?.()
    }

    // Try to parse JSON; fall back gracefully on empty bodies (e.g. 204).
    let data: unknown
    let errorMessage: string | undefined

    try {
      const parsed = await response.json()
      if (response.ok) {
        data = parsed
      } else {
        // 4xx/5xx: surface `parsed.error` as the error string, keep rest in data.
        errorMessage = typeof parsed?.error === 'string' ? parsed.error : JSON.stringify(parsed)
        data = parsed
      }
    } catch {
      // Body was empty or non-JSON.
      if (!response.ok) {
        errorMessage = `HTTP ${status}`
      }
    }

    if (response.ok) {
      return { ok: true, status, data }
    }
    const errResult: HttpResult = { ok: false, status, error: errorMessage }
    if (data !== undefined) errResult.data = data
    return errResult
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, error: message }
  }
}

export function get(path: string): Promise<HttpResult> {
  return request('GET', path)
}

export function post(path: string, body?: unknown): Promise<HttpResult> {
  return request('POST', path, body)
}

export function patch(path: string, body?: unknown): Promise<HttpResult> {
  return request('PATCH', path, body)
}

export function put(path: string, body?: unknown): Promise<HttpResult> {
  return request('PUT', path, body)
}

export function del(path: string, body?: unknown): Promise<HttpResult> {
  return request('DELETE', path, body)
}

/** Grouped export consumed by group factories. */
export const http = { get, post, patch, put, del } as const
export type Http = typeof http
