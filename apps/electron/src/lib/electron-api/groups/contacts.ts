/**
 * contacts.ts — REST SDK group for the contacts namespace.
 *
 * Per CONTRACTS.md (Contacts table) all methods are RESULT.
 * Call sites read `(result as any).error?.message` — so the error field
 * must be synthesized as { message: string, details?: unknown }.
 *
 * ERROR-OBJECT SYNTHESIS (per CONTRACTS §error-detail):
 *   result.error = { message: r.error, details: (r.data as any)?.details }
 */

import type { Http } from '../http'
import type {
  Result,
  GetContactsRequest,
  GetContactsResponse,
  UpdateContactRequest,
  Contact,
  ContactWithMeetings,
  Person,
} from '../types'

export interface ContactsDeps {
  http: Http
}

/** Synthesise an error object for call sites that read `result.error?.message`. */
function errObj(r: { error?: string; data?: unknown }): { message: string; details?: unknown } {
  return {
    message: r.error ?? 'Unknown error',
    details: (r.data as any)?.details,
  }
}

export function makeContactsGroup({ http }: ContactsDeps) {
  return {
    async getAll(request?: GetContactsRequest): Promise<Result<GetContactsResponse>> {
      const params = new URLSearchParams()
      if (request?.search) params.set('search', request.search)
      if (request?.type) params.set('type', request.type)
      if (request?.limit !== undefined) params.set('limit', String(request.limit))
      if (request?.offset !== undefined) params.set('offset', String(request.offset))
      const qs = params.toString()
      const r = await http.get(`/api/contacts${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as GetContactsResponse }
    },

    async getById(id: string): Promise<Result<ContactWithMeetings>> {
      const r = await http.get(`/api/contacts/${id}`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as ContactWithMeetings }
    },

    async create(request: {
      name: string
      email?: string | null
      type?: string
      role?: string | null
      company?: string | null
    }): Promise<Result<Person>> {
      const r = await http.post('/api/contacts', request)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as Person }
    },

    async update(request: UpdateContactRequest): Promise<Result<Contact>> {
      const { id, ...body } = request as any
      const r = await http.patch(`/api/contacts/${id}`, body)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as Contact }
    },

    async delete(id: string): Promise<Result<void>> {
      const r = await http.del(`/api/contacts/${id}`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: undefined }
    },

    async getForMeeting(meetingId: string): Promise<Result<Contact[]>> {
      const r = await http.get(`/api/meetings/${meetingId}/contacts`)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as Contact[] }
    },

    async setSelf(request: { contactId: string | null }): Promise<Result<Person | null>> {
      const r = await http.put('/api/contacts/self', request)
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as Person | null }
    },

    async getSelf(): Promise<Result<Person | null>> {
      const r = await http.get('/api/contacts/self')
      if (!r.ok) {
        return { success: false, error: errObj(r) as any }
      }
      return { success: true, data: r.data as Person | null }
    },
  }
}

export type ContactsGroup = ReturnType<typeof makeContactsGroup>
