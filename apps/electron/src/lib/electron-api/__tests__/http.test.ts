import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// These imports will fail until http.ts is created — that's the red state we want.
import { get, post, patch, put, del, setOnUnauthorized } from '../http'

function makeFetchMock(status: number, body: unknown, ok?: boolean): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: ok !== undefined ? ok : status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })
}

describe('http transport', () => {
  beforeEach(() => {
    // Reset onUnauthorized hook before each test
    setOnUnauthorized(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('GET resolves { ok: true, status: 200, data } on 200', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200, { a: 1 }))

    const result = await get('/api/x')

    expect(result).toEqual({ ok: true, status: 200, data: { a: 1 } })

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fetchCall[0]).toMatch(/\/api\/x$/)
    expect(fetchCall[1]).toMatchObject({ credentials: 'include', method: 'GET' })
  })

  it('POST sets Content-Type: application/json, serializes body, and includes credentials: include', async () => {
    vi.stubGlobal('fetch', makeFetchMock(400, { error: 'bad' }, false))

    const result = await post('/api/x', { b: 2 })

    expect(result).toEqual({ ok: false, status: 400, error: 'bad' })

    const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    const [url, init] = fetchCall
    expect(url).toMatch(/\/api\/x$/)
    expect(init.credentials).toBe('include')
    expect(init.method).toBe('POST')
    // Content-Type must be set for JSON writes
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    // Body must be JSON-serialized
    expect(JSON.parse(init.body)).toEqual({ b: 2 })
    // Must NOT set any custom same-origin header (X-Requested-With etc.)
    expect(headers['X-Requested-With']).toBeUndefined()
  })

  it('401 fires the onUnauthorized hook', async () => {
    vi.stubGlobal('fetch', makeFetchMock(401, { error: 'Unauthorized' }, false))

    const onUnauthorized = vi.fn()
    setOnUnauthorized(onUnauthorized)

    await get('/api/protected')

    expect(onUnauthorized).toHaveBeenCalledOnce()
  })

  it('network throw resolves { ok: false, status: 0, error } — never rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network failure'))
    )

    const result = await get('/api/x')

    expect(result).toEqual({ ok: false, status: 0, error: 'Network failure' })
  })

  it('PATCH/PUT/DEL are exported and send the correct method', async () => {
    vi.stubGlobal('fetch', makeFetchMock(200, null))
    await patch('/api/x', { c: 3 })
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PATCH')

    vi.stubGlobal('fetch', makeFetchMock(200, null))
    await put('/api/x', { d: 4 })
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('PUT')

    vi.stubGlobal('fetch', makeFetchMock(204, null))
    await del('/api/x')
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].method).toBe('DELETE')
  })
})
