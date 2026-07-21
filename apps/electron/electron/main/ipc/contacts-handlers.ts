/**
 * Contacts IPC Handlers
 *
 * Handles all contact-related IPC communication using the Result pattern.
 */

import { ipcMain } from 'electron'
import {
  getContacts,
  getContactById,
  updateContact,
  deleteContact,
  getMeetingsForContact,
  getContactsForMeeting,
  upsertContact,
  setSelfContact,
  clearSelfContact,
  getSelfContactId,
  Contact
} from '../services/database'
import { success, error, Result } from '../types/api'
import {
  GetContactsRequestSchema,
  GetContactByIdRequestSchema,
  UpdateContactRequestSchema,
  DeleteContactRequestSchema,
  CreateContactRequestSchema,
  SetSelfRequestSchema
} from '../validation/contacts'
import { randomUUID } from 'crypto'
import type { Person } from '@/types/knowledge'
import type { Meeting } from '@/types'

export function registerContactsHandlers(): void {
  /**
   * Get all contacts with optional search and pagination
   */
  ipcMain.handle(
    'contacts:getAll',
    async (_, request?: unknown): Promise<Result<{ contacts: Person[]; total: number }>> => {
      try {
        const parsed = GetContactsRequestSchema.safeParse(request ?? {})
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid request parameters', parsed.error.format())
        }

        const { search, type, limit, offset } = parsed.data
        const result = getContacts(search, type, limit, offset)

        return success({
          contacts: result.contacts.map(mapToPerson),
          total: result.total
        })
      } catch (err) {
        console.error('contacts:getAll error:', err)
        return error('DATABASE_ERROR', 'Failed to fetch contacts', err)
      }
    }
  )

  /**
   * Create a new contact (wraps upsertContact). Name required; duplicate emails allowed.
   */
  ipcMain.handle(
    'contacts:create',
    async (_, request: unknown): Promise<Result<Person>> => {
      try {
        const parsed = CreateContactRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid create request', parsed.error.format())
        }

        const now = new Date().toISOString()
        const created = upsertContact({
          id: randomUUID(),
          name: parsed.data.name,
          email: parsed.data.email ?? null,
          type: parsed.data.type ?? 'unknown',
          role: parsed.data.role ?? null,
          company: parsed.data.company ?? null,
          notes: null,
          tags: null,
          first_seen_at: now,
          last_seen_at: now,
          meeting_count: 0,
          is_self: 0
        })

        return success(mapToPerson(created))
      } catch (err) {
        console.error('contacts:create error:', err)
        return error('DATABASE_ERROR', 'Failed to create contact', err)
      }
    }
  )

  /**
   * Get contact by ID with associated meetings
   */
  ipcMain.handle(
    'contacts:getById',
    async (_, id: unknown): Promise<Result<{ contact: Person; meetings: Meeting[]; totalMeetingTimeMinutes: number }>> => {
      try {
        const parsed = GetContactByIdRequestSchema.safeParse({ id })
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid contact ID', parsed.error.format())
        }

        const contact = getContactById(parsed.data.id)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${parsed.data.id} not found`)
        }

        const meetings = getMeetingsForContact(parsed.data.id)

        // Calculate total meeting time
        let totalMeetingTimeMinutes = 0
        for (const meeting of meetings) {
          const start = new Date(meeting.start_time).getTime()
          const end = new Date(meeting.end_time).getTime()
          totalMeetingTimeMinutes += Math.round((end - start) / 60000)
        }

        return success({
          contact: mapToPerson(contact),
          meetings,
          totalMeetingTimeMinutes
        })
      } catch (err) {
        console.error('contacts:getById error:', err)
        return error('DATABASE_ERROR', 'Failed to fetch contact', err)
      }
    }
  )

  /**
   * Update contact
   */
  ipcMain.handle(
    'contacts:update',
    async (_, request: unknown): Promise<Result<Person>> => {
      try {
        const parsed = UpdateContactRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid update request', parsed.error.format())
        }

        const { id, tags, name, email, ...otherUpdates } = parsed.data
        const contact = getContactById(id)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${id} not found`)
        }

        const updates: Partial<Contact> = { ...otherUpdates }
        if (tags) {
          updates.tags = JSON.stringify(tags)
        }
        if (name !== undefined) {
          updates.name = name
        }
        if (email !== undefined) {
          updates.email = email
        }

        updateContact(id, updates)

        const updatedContact = getContactById(id)
        return success(mapToPerson(updatedContact!))
      } catch (err) {
        console.error('contacts:update error:', err)
        return error('DATABASE_ERROR', 'Failed to update contact', err)
      }
    }
  )

  /**
   * Delete contact and all meeting associations
   */
  ipcMain.handle(
    'contacts:delete',
    async (_, id: unknown): Promise<Result<void>> => {
      try {
        const parsed = DeleteContactRequestSchema.safeParse({ id })
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid contact ID', parsed.error.format())
        }

        const contact = getContactById(parsed.data.id)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${parsed.data.id} not found`)
        }

        deleteContact(parsed.data.id)

        return success(undefined)
      } catch (err) {
        console.error('contacts:delete error:', err)
        return error('DATABASE_ERROR', 'Failed to delete contact', err)
      }
    }
  )

  /**
   * Get contacts for a specific meeting
   */
  ipcMain.handle(
    'contacts:getForMeeting',
    async (_, meetingId: unknown): Promise<Result<Person[]>> => {
      try {
        if (typeof meetingId !== 'string') {
          return error('VALIDATION_ERROR', 'Meeting ID must be a string')
        }

        const contacts = getContactsForMeeting(meetingId)
        return success(contacts.map(mapToPerson))
      } catch (err) {
        console.error('contacts:getForMeeting error:', err)
        return error('DATABASE_ERROR', 'Failed to fetch contacts for meeting', err)
      }
    }
  )

  /**
   * Get the current "self" contact ("this is me").
   */
  ipcMain.handle(
    'contacts:getSelf',
    async (): Promise<Result<Person | null>> => {
      try {
        const selfId = getSelfContactId()
        if (!selfId) return success(null)
        const contact = getContactById(selfId)
        if (!contact) return success(null)
        return success(mapToPerson(contact))
      } catch (err) {
        console.error('contacts:getSelf error:', err)
        return error('DATABASE_ERROR', 'Failed to fetch self contact', err)
      }
    }
  )

  /**
   * Set or clear the "self" contact. Passing null clears the current self.
   */
  ipcMain.handle(
    'contacts:setSelf',
    async (_, request: unknown): Promise<Result<Person | null>> => {
      try {
        const parsed = SetSelfRequestSchema.safeParse(request)
        if (!parsed.success) {
          return error('VALIDATION_ERROR', 'Invalid set-self request', parsed.error.format())
        }

        if (parsed.data.contactId === null) {
          clearSelfContact()
          return success(null)
        }

        const contact = getContactById(parsed.data.contactId)
        if (!contact) {
          return error('NOT_FOUND', `Contact with ID ${parsed.data.contactId} not found`)
        }

        setSelfContact(parsed.data.contactId)
        return success(mapToPerson(contact))
      } catch (err) {
        console.error('contacts:setSelf error:', err)
        return error('DATABASE_ERROR', 'Failed to set self contact', err)
      }
    }
  )
}

function mapToPerson(contact: Contact): Person {
  let tags: string[] = []
  if (contact.tags) {
    try {
      tags = JSON.parse(contact.tags)
    } catch {
      tags = []
    }
  }

  return {
    id: contact.id,
    name: contact.name,
    email: contact.email,
    type: contact.type as any,
    role: contact.role,
    company: contact.company,
    notes: contact.notes,
    tags,
    isSelf: contact.is_self === 1,
    firstSeenAt: contact.first_seen_at,
    lastSeenAt: contact.last_seen_at,
    interactionCount: contact.interaction_count ?? contact.meeting_count,
    createdAt: contact.created_at,
    voiceprintCount: contact.voiceprint_count ?? 0
  }
}