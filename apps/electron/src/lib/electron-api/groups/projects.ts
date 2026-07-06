/**
 * projects.ts — REST SDK group for the projects namespace.
 *
 * Per CONTRACTS.md (Projects table) all methods are RESULT.
 * Call sites read result.success / result.data; error is read as a plain
 * string (no .message object synthesis needed for projects).
 */

import type { Http } from '../http'
import type {
  Result,
  GetProjectsRequest,
  GetProjectsResponse,
  CreateProjectRequest,
  UpdateProjectRequest,
  TagMeetingRequest,
  Project,
  ProjectWithMeetings,
} from '../types'

export interface ProjectsDeps {
  http: Http
}

export function makeProjectsGroup({ http }: ProjectsDeps) {
  return {
    async getAll(
      request?: GetProjectsRequest & { status?: string },
    ): Promise<Result<GetProjectsResponse>> {
      const params = new URLSearchParams()
      if ((request as any)?.search) params.set('search', (request as any).search)
      if (request?.status) params.set('status', request.status)
      if ((request as any)?.limit !== undefined) params.set('limit', String((request as any).limit))
      if ((request as any)?.offset !== undefined)
        params.set('offset', String((request as any).offset))
      const qs = params.toString()
      const r = await http.get(`/api/projects${qs ? `?${qs}` : ''}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      // GET /api/projects returns {items,total}; the consumer reads
      // GetProjectsResponse {projects,total}. Map items→projects (tolerate the
      // legacy 'projects' key too) and guard null/empty bodies.
      const body = r.data as { items?: Project[]; projects?: Project[]; total?: number } | null
      const data: GetProjectsResponse = {
        projects: body?.items ?? body?.projects ?? [],
        total: body?.total ?? 0,
      }
      return { success: true, data }
    },

    async getById(id: string): Promise<Result<ProjectWithMeetings>> {
      const r = await http.get(`/api/projects/${id}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: r.data as ProjectWithMeetings }
    },

    async create(request: CreateProjectRequest): Promise<Result<Project>> {
      const r = await http.post('/api/projects', request)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: r.data as Project }
    },

    async update(request: UpdateProjectRequest): Promise<Result<Project>> {
      const { id, ...body } = request as any
      const r = await http.patch(`/api/projects/${id}`, body)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: r.data as Project }
    },

    async delete(id: string): Promise<Result<void>> {
      const r = await http.del(`/api/projects/${id}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: undefined }
    },

    async tagMeeting(request: TagMeetingRequest): Promise<Result<void>> {
      const { meetingId, projectId } = request as any
      const r = await http.post(`/api/meetings/${meetingId}/projects/${projectId}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: undefined }
    },

    async untagMeeting(request: TagMeetingRequest): Promise<Result<void>> {
      const { meetingId, projectId } = request as any
      const r = await http.del(`/api/meetings/${meetingId}/projects/${projectId}`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: undefined }
    },

    async getForMeeting(meetingId: string): Promise<Result<Project[]>> {
      const r = await http.get(`/api/meetings/${meetingId}/projects`)
      if (!r.ok) {
        return { success: false, error: r.error ?? `HTTP ${r.status}` } as any
      }
      return { success: true, data: r.data as Project[] }
    },
  }
}

export type ProjectsGroup = ReturnType<typeof makeProjectsGroup>
