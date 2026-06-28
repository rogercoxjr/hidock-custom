# CONTRACTS.md — Per-method shape-contract inventory (0e Task 2)

> **What this is.** The authoritative return-shape spec for every `ElectronAPI` method (lifted into
> `src/lib/electron-api/types.ts`). Each SDK group method (Tasks 4–9) MUST return **exactly** the shape
> its existing renderer call sites destructure. A wrong wrap **typechecks** (call sites are loose `any`)
> but **fails silently at runtime** — this table is the safety net against that (0e Risks 1–3).
>
> **Classifications**
> - **RESULT** — returns `{success:true,data}` on 2xx / `{success:false,error}` on error; **never throws**. Call sites do `if (result.success)`.
> - **RAW-THROW** — returns the bare body on 2xx; **throws** on error. Call sites `await` a value (often `as T`), error handled by surrounding `try/catch`.
> - **STRING|FALSE** — id string on success, `false` on error. Call site `if (id)`.
> - **BOOL** — `true`/`false`.
> - **INLINE** — builds an exact inline `{success, data?/…, error?}` object (NOT the generic `Result<T>` envelope — fields differ per method).
> - **VOID** — resolves `void`/ignored value; awaited for side-effect only.
> - **EVENT** — `/ws` subscribe → returns `() => void` unsubscribe.
> - **DROPPED** — Electron-ism; not a REST call (removed / browser-native / download).
> - **PHASE-1** — device path (jensen/downloadService/onRecordingAdded); left as-is / stubbed in 0e.
>
> **REST column** is from `2026-06-26-hosted-hub-0c-rest-api-design.md` §3. **EVENT** channels are from
> `2026-06-26-hosted-hub-0c1-ws-broadcaster.md`. "**no endpoint**" = method has no 0c REST mapping (dropped/deferred — reason given).

---

## ⚠️ ERROR-DETAIL methods (http.ts must carry `data` on 4xx before these groups are built)

**Problem.** `http.ts` (lines 84–86) returns `{ ok:false, status, error }` on 4xx/5xx and **drops `data`** —
even though it parsed `data = parsed` at line 75. So a 4xx body's `details` (Zod field errors, etc.) and any
**structured `error`** is unreachable by the SDK adapter. Several RESULT/INLINE call sites read the error as an
**object with `.message`** (`result.error?.message`, `result.error.message`) — i.e. they expect `error` to be a
**`{ message, … }` object**, not a bare string. The 0c envelope is `{ error, details? }` where `error` is a string;
the renderer expects `error.message`. **The SDK adapter for every RESULT/INLINE method below must synthesize
`error: { message: <httpResult.error>, details?: <4xx body.details> }`** — which means `http.ts` must be extended
to **carry the 4xx `data` (the parsed `{error, details}` body) through to the adapter**, not just the `error` string.

**Action for the http transport (do before Task 6/7/8):** add `data?` to the error branch of `HttpResult`
(return `{ ok:false, status, error, data }`) so adapters can build `error:{message, details}` and surface Zod
field errors. The http test must assert `data` survives on a 4xx.

**Methods that read `error.message` or need 4xx `details` (RESULT/INLINE):**
| Method | Call site | Reads |
|---|---|---|
| `contacts.getAll` / `getById` / `update` / `delete` | `useContactsStore.ts:72,122,142` | `(result as any).error?.message` |
| `outputs.generate` | `Actionables.tsx:154,266` | `result.error.message` |
| `outputs.copyToClipboard` *(DROPPED)* | `Actionables.tsx:172` | `result.error.message` |
| `meetings.update` | `RecordingLinkDialog.tsx:135`; `MeetingDetail.tsx` | `result.error` (string ok) |
| `speakers.reassignTurns` | `SourceReader.tsx:333` | `res?.error?.message` |
| `transcripts.export` | `SourceReader.tsx:780` | `res.error.message` |
| `rag.status` / `rag.globalSearch` | `Chat.tsx`; `Explore.tsx:115` | `result.error.message` |
| `summarizationTemplates.list` (+ all CRUD) | `SummarizationTemplatesCard.tsx:136` | `(res as FailResult).error?.message` |
| `config.get` / `config.updateSection` | `useConfigStore.ts:28,46` | `result.error?.message` |
| `summarization.listModels` / `testConnection` | `Settings.tsx:491,510` | `{success, error}` (validation msg) — Zod `details` valuable |
| `recordings.addExternalByPath` (INLINE) | `Library.tsx:211` | `result.error` |

**Count: 12 method families need the 4xx `data`/structured-error fix.** (Largest validation-detail value:
`summarization.*`, `summarizationTemplates.*`, `contacts.*`, where a Zod field error tells the user *what* is wrong.)

---

## Top-level App / Config / Summarization

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `app.restart` | **no endpoint** — DROPPED (0c §4: no desktop relaunch) | DROPPED | no-op resolve, or remove lone caller | (no renderer call site found) |
| `app.info` | `GET /api/app/info` (0c-5) | RAW-THROW | bare `{version,name,isPackaged,platform}` | `Layout.tsx:119` (`.then((info)=>…)`) |
| `config.get` | `GET /api/config` (0c-5) | **RESULT** | typed `Promise<any>` but call site reads `result.success`/`result.data`/`result.error?.message` — IPC returns a Result envelope | `useConfigStore.ts:24-28`; `Device.tsx:183` |
| `config.set` | `PATCH /api/config` *(admin)* | RESULT | same envelope as `get` | (no direct renderer call site; via store) |
| `config.updateSection` | `PATCH /api/config` *(admin)* | **RESULT** | `result.success`/`result.data`/`result.error?.message` | `useConfigStore.ts:42-46`; `Device.tsx:625,637` |
| `config.getValue` | `GET /api/config?key=` (0c-5) | RAW-THROW | bare value | (no renderer call site found) |
| `summarization.listModels` | `GET /api/summarization/models` (0c-4) | INLINE | `{success, models?, error?}` — `if (result.success)` | `Settings.tsx:491` |
| `summarization.testConnection` | `POST /api/summarization/test-connection` (0c-4) | INLINE | `{success, error?}` | `Settings.tsx:510` |

## Meetings

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `meetings.getAll` | `GET /api/meetings?startDate&endDate` (0c-3) | RAW-THROW | bare `any[]` | `useAppStore.ts:175` |
| `meetings.getById` | `GET /api/meetings/:id` (0c-3) | RAW-THROW | bare row (404→throw) | (no direct renderer call; via stores) |
| `meetings.getByIds` | `POST /api/meetings/by-ids` (0c-3) | RAW-THROW | bare `Record<string,any>` | `Library.tsx:355` |
| `meetings.getDetails` | `GET /api/meetings/:id/details` (0c-3) | RAW-THROW | bare object | `MeetingDetail.tsx:117` (`const data = await …`) |
| `meetings.update` | `PATCH /api/meetings/:id` (0c-3) | **RESULT** | `Result<any>`; `result.success`/`result.error` | `RecordingLinkDialog.tsx:135`; `MeetingDetail.tsx:180` |

## Contacts (all RESULT)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `contacts.getAll` | `GET /api/contacts?search&type&limit&offset` (0c-3) | RESULT | `{success:true,data:{contacts,total}}` (`GetContactsResponse`); reads `result.data.contacts`/`result.data.total` | `useContactsStore.ts:55`; `People.tsx:67` |
| `contacts.getById` | `GET /api/contacts/:id` (0c-3) | RESULT | `Result<ContactWithMeetings>`; reads `result.data.contact` | `useContactsStore.ts:84`; `PersonDetail.tsx:82`; `Projects.tsx:202` |
| `contacts.create` | `POST /api/contacts` (0c-3) | RESULT | `Result<Person>`; `res.success`/`res.data` (via `(window as any)`) | `QuickAddContact.tsx:32`; `SpeakersPanel.tsx:295`; `SpeakerTargetPicker.tsx:96` |
| `contacts.update` | `PATCH /api/contacts/:id` (0c-3) | RESULT | `Result<Contact>`; `result.success` | `useContactsStore.ts:113`; `PersonDetail.tsx:154` |
| `contacts.delete` | `DELETE /api/contacts/:id` (0c-3) | RESULT | `Result<void>`; `result.success` | `useContactsStore.ts:133`; `People.tsx:123`; `PersonDetail.tsx:181` |
| `contacts.getForMeeting` | `GET /api/meetings/:id/contacts` (0c-3) | RESULT | `Result<Contact[]>`; `res.success`/`res.data` | `SpeakersPanel.tsx:213`; `SpeakerTargetPicker.tsx:61` |
| `contacts.setSelf` | `PUT /api/contacts/self` (0c-3) | RESULT | `Result<Person\|null>`; `result.success` | `PersonDetail.tsx:200,232` |
| `contacts.getSelf` | `GET /api/contacts/self` (0c-3) | RESULT | `Result<Person\|null>`; `selfResult` used | `PersonDetail.tsx:215` |

## Voiceprints (all RESULT)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `voiceprints.listForContact` | `GET /api/contacts/:id/voiceprints` (0c-5) | RESULT | `Result<VoiceprintSummary[]>`; `result.success`/`result.data` | `PersonDetail.tsx:305` |
| `voiceprints.disable` | `PATCH /api/voiceprints/:id` `{enabled:false}` (0c-5) | RESULT | `Result<void>` | `PersonDetail.tsx:249` (`enable?…:disable`) |
| `voiceprints.enable` | `PATCH /api/voiceprints/:id` `{enabled:true}` (0c-5) | RESULT | `Result<void>` | `PersonDetail.tsx:249` |
| `voiceprints.delete` | `DELETE /api/voiceprints/:id` (0c-5) | RESULT | `Result<void>`; `result.success` | `PersonDetail.tsx:266`; `SpeakersPanel.tsx:340` |
| `voiceprints.clearAllForContact` | `DELETE /api/voiceprints?contactId=` (0c-5) | RESULT | `Result<{deleted}>`; `result.success` | `PersonDetail.tsx:282` |
| `voiceprints.clearAll` | `DELETE /api/voiceprints` (0c-5) | RESULT | `Result<{deleted}>`; `result.success` | `Settings.tsx:559` |
| `voiceprints.findBySource` | `GET /api/voiceprints?recordingId&fileLabel&contactId` (0c-5) | RESULT | `Result<VoiceprintSummary[]>`; `findRes` used | `SpeakersPanel.tsx:317` |

## Speakers (all RESULT)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `speakers.assign` | `PUT /api/recordings/:id/speakers/:fileLabel` (0c-5) | RESULT | `res.success` | `SpeakersPanel.tsx:273` |
| `speakers.merge` | `POST /api/recordings/:id/speakers/merge` (0c-5) | RESULT | `res.success` | `SpeakersPanel.tsx:362` |
| `speakers.unassign` | `DELETE /api/recordings/:id/speakers/:fileLabel` (0c-5) | RESULT | `Result<void>` | `SpeakersPanel.tsx:311` |
| `speakers.getForRecording` | `GET /api/recordings/:id/speakers` (0c-5) | RESULT | `Result<Record<…>>`; `speakerRes?.success && speakerRes.data` | `SourceReader.tsx:264,277` |
| `speakers.getSuggestions` | `GET /api/recordings/:id/speaker-suggestions` (0c-5) | RESULT | `Result<SuggestionView[]>`; `sugRes?.success && Array.isArray(sugRes.data)` | `SourceReader.tsx:292,294` |
| `speakers.reassignTurns` | `POST /api/recordings/:id/speakers/reassign` (0c-5) | RESULT | `res?.success`; `res?.error?.message` | `SourceReader.tsx:329-333` |
| `speakers.dismissSuggestion` | `POST /api/speaker-suggestions/:id/dismiss` (0c-5) | RESULT | `Result<{id}>`; `res.success` | `SpeakersPanel.tsx:382,459` |
| `speakers.acceptSuggestion` | `POST /api/speaker-suggestions/:id/accept` (0c-5) | RESULT | `Result<{id}>`; `res.success` | `SpeakersPanel.tsx:397` |
| `speakers.setSelf` | `POST /api/recordings/:id/speakers/:fileLabel/set-self` (0c-5) | RESULT | `Result<{selfAssigned,…}>`; `res.success` | `SpeakersPanel.tsx:439` |

## Diarization

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `diarization.getLatestRun` | `GET /api/recordings/:id/diarization` (0c-5) | RESULT | `Result<DiarizationRun\|null>` (per type) | **no renderer call site** — classify by type signature |
| `diarization.getRunsForRecording` | `GET /api/recordings/:id/diarization?all=1` (0c-5) | RESULT | `Result<DiarizationRun[]>` (per type) | **no renderer call site** — classify by type signature |

## Summarization Templates

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `summarizationTemplates.list` | `GET /api/summarization-templates` (0c-4) | RESULT | `res?.success`/`res.data`; `(res as FailResult).error?.message` | `SummarizationTemplatesCard.tsx:132` |
| `summarizationTemplates.create` | `POST /api/summarization-templates` (0c-4) | RESULT | `res?.success` | `SummarizationTemplatesCard.tsx:219` |
| `summarizationTemplates.update` | `PATCH /api/summarization-templates/:id` (0c-4) | RESULT | `res?.success` (also used for `{isDefault:true}` patch) | `SummarizationTemplatesCard.tsx:210,255` |
| `summarizationTemplates.setEnabled` | `PATCH /api/summarization-templates/:id` `{enabled}` (0c-4) | RESULT | `Result<true>`; `res?.success` | `SummarizationTemplatesCard.tsx:239` |
| `summarizationTemplates.delete` | `DELETE /api/summarization-templates/:id` (0c-4) | RESULT | `Result<true>`; `res?.success` | `SummarizationTemplatesCard.tsx:273` |
| `summarizationTemplates.latestRun` | `GET /api/recordings/:id/template-run` (0c-4) | RESULT | `Result<LatestRunView>` | `SourceReader.tsx:196,220` (chip; `?.success`) |
| `summarizationTemplates.resummarizeWithTemplate` | `POST /api/recordings/:id/resummarize` `{templateId}` (0c-2b/0c-4) | INLINE | `{success, error?}` (NOT generic Result) — `res?.success` | `SourceReader.tsx:841` |
| `summarizationTemplates.previewSelection` | `GET /api/recordings/:id/template-selection` (0c-4) | RESULT | `Result<PreviewSelectionResult>`; `res?.success` | `SummarizationTemplatesCard.tsx:301` |
| `summarizationTemplates.acceptSuggestedTemplate` | `POST /api/recordings/:id/accept-suggested-template` (0c-4) | RESULT | `Result<SummarizationTemplate>`; `res?.success` | `TemplateChip.tsx:137` |

## Projects (all RESULT)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `projects.getAll` | `GET /api/projects?…` (0c-3) | RESULT | `Result<GetProjectsResponse>`; `result.success`/`result.data` | `useProjectsStore.ts:46`; `Projects.tsx:83` |
| `projects.getById` | `GET /api/projects/:id` (0c-3) | RESULT | `Result<ProjectWithMeetings>`; `result.success` | `useProjectsStore.ts:76`; `Projects.tsx:184` |
| `projects.create` | `POST /api/projects` (0c-3) | RESULT | `Result<Project>`; `result.success` | `useProjectsStore.ts:100`; `Projects.tsx:129` |
| `projects.update` | `PATCH /api/projects/:id` (0c-3) | RESULT | `Result<Project>`; `result.success` | `useProjectsStore.ts:129`; `Projects.tsx:228,382` |
| `projects.delete` | `DELETE /api/projects/:id` (0c-3) | RESULT | `Result<void>`; `result.success` | `useProjectsStore.ts:155`; `Projects.tsx:164` |
| `projects.tagMeeting` | `POST /api/meetings/:id/projects/:projectId` (0c-3) | RESULT | `Result<void>` | (via `useProjectsStore`; `types/stores.ts:74`) |
| `projects.untagMeeting` | `DELETE /api/meetings/:id/projects/:projectId` (0c-3) | RESULT | `Result<void>` | (via `useProjectsStore`; `types/stores.ts:75`) |
| `projects.getForMeeting` | `GET /api/meetings/:id/projects` (0c-3) | RESULT | `Result<Project[]>` | (via store; no direct page call) |

## Recordings

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `recordings.getAll` | `GET /api/recordings?limit&offset…` → `{items,total}` (0c-2) | RAW-THROW | **unwrap `.items` to bare `any[]`** (pagination caveat — Risk 3 / Task 5b for `total`) | `useUnifiedRecordings.ts:420` (`as DatabaseRecording[]`) |
| `recordings.getById` | `GET /api/recordings/:id` (0c-2) | RAW-THROW | bare row; 404→throw | (via stores; `db:get-recording` twin) |
| `recordings.getForMeeting` | `GET /api/meetings/:id/recordings` (0c-2) | RAW-THROW | bare `any[]` | `RecordingLinkDialog.tsx:77` |
| `recordings.updateStatus` | `PATCH /api/recordings/:id` `{status}` (0c-2) | RAW-THROW/VOID | typed `any`; awaited for side-effect, return ignored | `useOperations.ts:58,113`; `MeetingDetail.tsx` |
| `recordings.updateRecordingStatus` | `PATCH /api/recordings/:id` `{status}` (0c-2) | INLINE | `{success,data?,error?}` (per type) | (no renderer call site found) |
| `recordings.updateTranscriptionStatus` | `PATCH /api/recordings/:id` `{transcriptionStatus}` (0c-2) | INLINE | `{success,data?,error?}` (per type) | (no renderer call site found) |
| `recordings.linkToMeeting` | `POST /api/recordings/:id/link-meeting` (0c-2) | RAW-THROW | typed `any` | (no direct renderer call; `RecordingLinkDialog` uses `selectMeeting`) |
| `recordings.delete` | `DELETE /api/recordings/:id` (0c-2) | BOOL | `2xx`→`true`; awaited, return ignored | `Library.tsx:595,653,683`; `Calendar.tsx:569` |
| `recordings.deleteBatch` | `POST /api/recordings/batch-delete` (0c-2) | INLINE | `{success,deleted,failed,errors}` | (no direct renderer call site found) |
| `recordings.getCandidates` | `GET /api/recordings/:id/candidates` (0c-2) | INLINE | `{success,data,error?}`; `candidatesResult.success`/`.data`/`.error` | `RecordingLinkDialog.tsx:73,84-89`; `MeetingDetail.tsx:239` |
| `recordings.getMeetingsNearDate` | `GET /api/recordings/meetings-near-date?date=` (0c-2) | INLINE | `{success,data,error?}`; `nearbyResult.success?…:[]` | `RecordingLinkDialog.tsx:74,90` |
| `recordings.selectMeeting` | `POST /api/recordings/:id/select-meeting` (0c-2) | INLINE | `{success,error?}`; `result.success`/`result.error` | `RecordingLinkDialog.tsx:153,175`; `MeetingDetail.tsx:225,253`; `SourceReader.tsx:432` |
| `recordings.addExternal` | **no endpoint** — DROPPED (0c §4: native OS picker) → browser `<input type=file>` → `POST /api/recordings/upload` | DROPPED | replaced by upload flow (Task 10); current return `{success,recording?,error?}` | `Library.tsx:505` |
| `recordings.addExternalByPath` | `POST /api/recordings/upload` (multipart, 0c-2) | INLINE | `{success,recording?,error?}`; `result.success`/`result.error`. Path-based form has no server filesystem — re-point to upload | `Library.tsx:211` |
| `recordings.transcribe` | `POST /api/recordings/:id/transcribe` (0c-2b) | STRING\|FALSE | queue-item id on 2xx, `false` on error; `if (!queueItemId)`. **FORCE re-transcribe path** (clears stage markers) — see 0c-2b §9 verify `transcribe`≠`addToQueue` | `useOperations.ts:66` |
| `recordings.addToQueue` | `POST /api/recordings/:id/transcribe` (0c-2b) | STRING\|FALSE | queue-item id / `false`; `if (queueItemId)` | `useOperations.ts:67,114` |
| `recordings.processQueue` | `POST /api/queue/process` (0c-2b) | BOOL | `Promise<boolean>` | (no direct renderer call site found) |
| `recordings.getTranscriptionStatus` | `GET /api/queue/status` (0c-2b) | INLINE | `{isProcessing,pendingCount,processingCount}` | (no direct renderer call site found) |
| `recordings.getTranscriptionQueue` | `GET /api/queue?status=` (0c-2b) | RAW-THROW | bare `any[]`; `.then((items:any[])=>…)` | `useTranscriptionSync.ts:24,126` |
| `recordings.cancelTranscription` | `POST /api/recordings/:id/transcription/cancel` (0c-2b) | INLINE | `{success}`; awaited, return ignored (throw caught) | `useOperations.ts:130` |
| `recordings.cancelAllTranscriptions` | `POST /api/queue/cancel-all` (0c-2b) | INLINE | `{success,count}`; reads `result.count` | `useOperations.ts:146` |
| `recordings.updateQueueItem` | `PATCH /api/queue/:id` (0c-2b) | BOOL | `Promise<boolean>` | (no direct renderer call site found) |
| `recordings.validateTranscriptionConfig` | `GET /api/transcription/config/validate` (0c-2b) | INLINE | `{ok, problems[]}`; `check.ok`/`check.problems` (throw caught) | `useOperations.ts:41,94` |
| `recordings.resummarize` | `POST /api/recordings/:id/resummarize` (0c-2b) | INLINE | `{success,error?}` | `Library.tsx:1213` |
| `recordings.isSummaryStale` | `GET /api/recordings/:id/summary-stale` (0c-2b) | BOOL | `Promise<boolean>` | (no direct renderer call site found; via SourceReader prop) |
| `recordings.retryAllFailed` | `POST /api/queue/retry-failed` (0c-2b) | INLINE | `{success,count}` | (no direct renderer call site found) |

## Transcripts

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `transcripts.getByRecordingId` | `GET /api/recordings/:id/transcript` (0c-2b) | RAW-THROW | bare row `as Transcript\|null` | `useUnifiedRecordings`/`SourceReader.tsx:263`; `Library.tsx:1223` |
| `transcripts.getByRecordingIds` | `POST /api/transcripts/by-recording-ids` (0c-2b) | RAW-THROW | bare `Record<string,any>` | `Library.tsx:353` |
| `transcripts.search` | `GET /api/transcripts/search?q=` (0c-2b) | RAW-THROW | bare `any[]` | (no direct renderer call site found) |
| `transcripts.updateTurns` | `PATCH /api/recordings/:id/transcript/turns` (0c-2b, raised bodyLimit) | RESULT | `Result<{recordingId}>` | (no direct renderer call site; speaker reassign flow) |
| `transcripts.export` | `POST /api/recordings/:id/transcript/export?format=` → download body (0c-2b/§4) | RESULT | `Result<string\|null>`; `res.success`/`res.error.message`/`res.data` (null=cancelled). **Browser download** — Task 10 turns body into anchor/Blob | `SourceReader.tsx:778` |

## Queue

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `queue.getItems` | `GET /api/queue?status=` (0c-2b) | RAW-THROW | bare `any[]` | (no direct renderer call site found; `db:get-queue` twin) |

## Knowledge

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `knowledge.getAll` | `GET /api/knowledge?limit&offset&status&quality&category` (0c-3) | RAW-THROW | bare `KnowledgeCapture[]` | `useUnifiedRecordings.ts:423`; `ContextPicker.tsx:24`; `SmartLabelsCard.tsx:38` |
| `knowledge.getById` | `GET /api/knowledge/:id` (0c-3) | RAW-THROW | bare `KnowledgeCapture\|null` | `Chat.tsx:167,401` |
| `knowledge.getByIds` | `POST /api/knowledge/by-ids` (0c-3) | RAW-THROW | bare `KnowledgeCapture[]` | `Chat.tsx:319` |
| `knowledge.update` | `PATCH /api/knowledge/:id` (0c-3) | INLINE | `{success,error?}`; `result.success` | `SourceReader.tsx:374,410`; `SmartLabelsCard.tsx:41` |

## Actionables

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `actionables.getAll` | `GET /api/actionables?status=` (0c-4) | RAW-THROW | bare `Actionable[]` | `Actionables.tsx:117`; `Home.tsx:50` |
| `actionables.getByMeeting` | `GET /api/meetings/:id/actionables` (0c-4) | RAW-THROW | bare `Actionable[]` | `MeetingDetail.tsx:125` |
| `actionables.updateStatus` | `PATCH /api/actionables/:id` (0c-4) | INLINE | `{success,error?}`; `result.success`/`result.error` | `Actionables.tsx:263,269,277,292` |
| `actionables.generateOutput` | `POST /api/actionables/:id/generate-output` (0c-4) | INLINE | `{success,error?,data?}`; `approvalResult.success`/`.error` | `Actionables.tsx:241` |

## Assistant

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `assistant.getConversations` | `GET /api/assistant/conversations` (0c-4) | RAW-THROW | bare `Conversation[]` | `Chat.tsx:264,308` |
| `assistant.createConversation` | `POST /api/assistant/conversations` (0c-4) | RAW-THROW | bare `Conversation`; reads `newConv.id` | `Chat.tsx:176,337,580` |
| `assistant.deleteConversation` | `DELETE /api/assistant/conversations/:id` (0c-4) | INLINE | `{success,error?}` (per type); awaited fire-and-forget (throw caught) | `Chat.tsx:364` |
| `assistant.getMessages` | `GET /api/assistant/conversations/:id/messages` (0c-4) | RAW-THROW | bare `Message[]` | `Chat.tsx:293` |
| `assistant.addMessage` | `POST /api/assistant/conversations/:id/messages` (0c-4) | RAW-THROW | bare `Message`; reads `.id` | `Chat.tsx:594,602,607,…` |
| `assistant.updateConversationTitle` | `PATCH /api/assistant/conversations/:id` (0c-4) | INLINE | `{success,error?}`; awaited | `Chat.tsx:625` |
| `assistant.addContext` | `POST /api/assistant/conversations/:id/context` (0c-4) | INLINE | `{success,error?}`; awaited | `Chat.tsx:183,189,398` |
| `assistant.removeContext` | `DELETE /api/assistant/conversations/:id/context` (0c-4) | INLINE | `{success,error?}`; awaited | `Chat.tsx:240,391,1090` |
| `assistant.getContext` | `GET /api/assistant/conversations/:id/context` (0c-4) | RAW-THROW | bare `string[]` | `Chat.tsx:294` |

## Chat (legacy chat-history store)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `chat.getHistory` | `GET /api/chat/history?limit=` (0c-3) | RAW-THROW | bare `any[]` | (no direct renderer call site found; `db:get-chat-history` twin) |
| `chat.addMessage` | `POST /api/chat/messages` (0c-3) | RAW-THROW | bare row | (no direct renderer call site found) |
| `chat.clearHistory` | `DELETE /api/chat/history` (0c-3) | BOOL | `Promise<boolean>` | (no direct renderer call site found) |

## Calendar

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `calendar.sync` | `POST /api/calendar/sync` (0c-3) | RAW-THROW | typed `any`; `useAppStore.ts:186` reads `result` | `useAppStore.ts:186` |
| `calendar.clearAndSync` | `POST /api/calendar/sync?clear=1` (0c-3) | RAW-THROW | typed `any`; `result` used | `Calendar.tsx:436` |
| `calendar.getLastSync` | `GET /api/calendar/last-sync` (0c-3) | RAW-THROW | bare `string\|null` | (no direct renderer call site found) |
| `calendar.setUrl` | `PATCH /api/calendar/settings` `{url}` (0c-3) | RAW-THROW | typed `any` | (no direct renderer call site found) |
| `calendar.toggleAutoSync` | `PATCH /api/calendar/settings` `{autoSync}` (0c-3) | RAW-THROW/VOID | typed `any`; awaited | `Calendar.tsx:520` |
| `calendar.setInterval` | `PATCH /api/calendar/settings` `{interval}` (0c-3) | RAW-THROW | typed `any` | (no direct renderer call site found) |
| `calendar.getSettings` | `GET /api/calendar/settings` (0c-3) | RAW-THROW | typed `any` | (no direct renderer call site found) |

## Storage

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `storage.getInfo` | `GET /api/storage/info` (0c-5) | RAW-THROW | typed `any`; `result` used | `Settings.tsx:270` |
| `storage.openFolder` | **no endpoint** — DROPPED (0c §4: no server desktop) | DROPPED | remove call sites / hide affordance (Task 10) | `Library.tsx:492`; `Settings.tsx:522` |
| `storage.openFile` | **no endpoint** — DROPPED (0c §4) | DROPPED | remove/disable (Task 10) | `SourceReader.tsx:679` |
| `storage.revealInFolder` | **no endpoint** — DROPPED (0c §4) | DROPPED | remove/disable (Task 10) | `SourceReader.tsx:689` |
| `storage.readRecording` | **no endpoint** — DROPPED (0c §4: base64-over-JSON; use 0d media URL) | DROPPED | re-point audio to 0d `GET /api/recordings/:id/media` | `useAudioPlayback.ts:231` |
| `storage.deleteRecording` | **no endpoint** — DROPPED (0c §4) | DROPPED | grep-confirm no remaining caller | (no direct renderer call site found) |
| `storage.saveRecording` | **no endpoint** — DROPPED (0c §4: device-write path; Phase-1 upload) | DROPPED | device download path (Phase 1) | `hidock-device.ts:1316` (device path) |

## Synced files

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `syncedFiles.isFileSynced` | `GET /api/synced-files/lookup?filename=` (0c-3) | BOOL | `Promise<boolean>` | (no direct renderer call site found) |
| `syncedFiles.getSyncedFile` | `GET /api/synced-files/lookup?filename=` (0c-3) | RAW-THROW | bare row \| `undefined` | (no direct renderer call site found) |
| `syncedFiles.getAll` | `GET /api/synced-files` (0c-3) | RAW-THROW | bare array (`as SyncedFile[]`) | `useUnifiedRecordings.ts:421` |
| `syncedFiles.add` | `POST /api/synced-files` (0c-3) | RAW-THROW | bare id string | (no direct renderer call site found) |
| `syncedFiles.remove` | `DELETE /api/synced-files?filename=` (0c-3) | BOOL | `Promise<boolean>` | (no direct renderer call site found) |
| `syncedFiles.getFilenames` | `GET /api/synced-files/filenames` (0c-3) | RAW-THROW | bare `string[]` | `Device.tsx:151,167` |

## Outputs

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `outputs.getTemplates` | `GET /api/outputs/templates` (0c-4) | RESULT | `Result<OutputTemplate[]>` | (no direct renderer call site found) |
| `outputs.generate` | `POST /api/outputs/generate` (0c-4) | RESULT | `result.success`/`result.data`/`result.error.message` | `Actionables.tsx:142,249,516` |
| `outputs.getByActionableId` | `GET /api/actionables/:id/output` (0c-4) | RESULT | `Result<…\|null>` | `Actionables.tsx:501` |
| `outputs.copyToClipboard` | **no endpoint** — DROPPED (0c §4: renderer concern) | DROPPED | `navigator.clipboard.writeText` (Task 10). Current call site reads `result.success`/`result.error.message` — replace with try/catch | `Actionables.tsx:168` |
| `outputs.saveToFile` | `POST /api/outputs/download` → body + `Content-Disposition` (0c-4/§4) | DROPPED→download | **browser download** (anchor + Blob, Task 10); current returns `Result<string>` (`result` used) | `Chat.tsx:490` |

## RAG

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `rag.status` | `GET /api/rag/status` (0c-4) | RESULT | `result.success`/`result.data` | `Chat.tsx:419` |
| `rag.chat` | `POST /api/rag/chat` (0c-4, full response over HTTP, NO token stream) | RESULT | `Result<RAGChatResponse>` | (no direct renderer call site; `chatLegacy` used) |
| `rag.chatLegacy` | `POST /api/rag/chat` (0c-4) | RAW-THROW | bare `{answer,sources,error?}`; reads `response.error`/`.answer`/`.sources` (NOT `.success`) | `Chat.tsx:599,708` |
| `rag.summarizeMeeting` | `POST /api/rag/summarize-meeting` (0c-4) | RESULT | `Result<string>` | (no direct renderer call site found) |
| `rag.findActionItems` | `POST /api/rag/find-action-items` (0c-4) | RESULT | `Result<string>` | (no direct renderer call site found) |
| `rag.cancel` | `POST /api/rag/cancel` (0c-4) | RESULT | `Result<boolean>`; awaited | `Chat.tsx:554` |
| `rag.removeLastMessages` | `POST /api/rag/session/trim` (0c-4) | RESULT | `Result<number>`; awaited | `Chat.tsx:697` |
| `rag.clearSession` | `POST /api/rag/session/clear` (0c-4) | RESULT | `Result<void>`; awaited | `Chat.tsx:700` |
| `rag.stats` | `GET /api/rag/stats` (0c-4) | RAW-THROW | bare `{documentCount,…}` | (no direct renderer call site found) |
| `rag.indexTranscript` | `POST /api/rag/index` (0c-4, raised bodyLimit) | RAW-THROW | bare `{indexed}` | (no direct renderer call site found) |
| `rag.search` | `GET /api/rag/search?q&limit` (0c-4) | RAW-THROW | bare array | (no direct renderer call site found) |
| `rag.getChunks` | `GET /api/rag/chunks` (0c-4) | RAW-THROW | bare array; `const data = await …` | `Chat.tsx:433` |
| `rag.globalSearch` | `GET /api/rag/search?q&limit&scope=` (0c-4) | RESULT | `result.success`/`result.data`/`result.error.message` | `Explore.tsx:101,111-115` |

## Quality

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `quality.get` | `GET /api/recordings/:id/quality` (0c-4) | RAW-THROW | typed `any` | **no renderer call site** — classify by type/endpoint |
| `quality.set` | `PUT /api/recordings/:id/quality` (0c-4) | RAW-THROW | typed `any` | **no renderer call site** |
| `quality.autoAssess` | `POST /api/recordings/:id/quality/auto-assess` (0c-4) | RAW-THROW | typed `any` | **no renderer call site** |
| `quality.getByQuality` | `GET /api/recordings?quality=` (0c-2/0c-4) | RAW-THROW | typed `any` (filtered recordings list) | **no renderer call site** |
| `quality.batchAutoAssess` | `POST /api/quality/batch-assess` (0c-4) | RAW-THROW | typed `any` | **no renderer call site** |
| `quality.assessUnassessed` | `POST /api/quality/assess-unassessed` (0c-4) | RAW-THROW | typed `any` | **no renderer call site** |

## Storage Policy (no renderer call sites — classify by type/endpoint)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `storagePolicy.getByTier` | `GET /api/storage-policy/by-tier?tier=` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.getCleanupSuggestions` | `GET /api/storage-policy/cleanup-suggestions` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.getCleanupSuggestionsForTier` | `GET /api/storage-policy/cleanup-suggestions?tier=` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.executeCleanup` | `POST /api/storage-policy/execute-cleanup` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.getStats` | `GET /api/storage-policy/stats` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.initializeUntiered` | `POST /api/storage-policy/initialize-untiered` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |
| `storagePolicy.assignTier` | `POST /api/storage-policy/assign-tier` (0c-5) | RAW-THROW | typed `any` | **no renderer call site** |

## Integrity (admin routes; progress via WS)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `integrity.runScan` | `POST /api/integrity/run-scan` *(admin)* (0c-5) | RAW-THROW | bare scan report; `setReport(result)` (throw caught) | `HealthCheck.tsx:69,86` |
| `integrity.getReport` | `GET /api/integrity/report` *(admin)* (0c-5) | RAW-THROW | typed `any` | (no direct renderer call site found) |
| `integrity.repairIssue` | `POST /api/integrity/repair-issue` *(admin)* (0c-5) | INLINE | `{issueId,success,action,error?}` | (no direct renderer call site found) |
| `integrity.repairAll` | `POST /api/integrity/repair-all` *(admin)* (0c-5) | INLINE-array | `Array<{issueId,success,action,error?}>`; `setRepairResults(results)` | `HealthCheck.tsx:83` |
| `integrity.runStartupChecks` | `POST /api/integrity/run-startup-checks` *(admin)* (0c-5) | RAW-THROW | bare `{issuesFound,issuesFixed}` | (no direct renderer call site found) |
| `integrity.cleanupWronglyNamed` | `POST /api/integrity/cleanup-wrongly-named` *(admin)* (0c-5) | RAW-THROW | bare `{deletedFiles,keptFiles,clearedDbRecords}` | `HealthCheck.tsx:105` |
| `integrity.purgeMissingFiles` | `POST /api/integrity/purge-missing-files` *(admin)* (0c-5) | RAW-THROW | bare `{totalRecords,deleted,kept,deletedFiles}` | `HealthCheck.tsx:124` |
| `integrity.onProgress` | `/ws` channel `integrity:progress` | EVENT | `(cb)=>()=>void`; payload `{message,progress}` | (Task 4 wiring) |

## Migration (MigrationAPI — admin routes; no renderer call sites)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `migration.getStatus` | `GET /api/migration/status` *(admin)* (0c-5) | RAW-THROW | bare `MigrationStatus {pending,migrated,skipped,total,error?}` | **no renderer call site found** — invoked from main/bootstrap, not `src` |
| `migration.previewCleanup` | `GET /api/migration/preview` *(admin)* (0c-5) | RAW-THROW | bare `MigrationCleanupPreview` | **no renderer call site found** |
| `migration.runCleanup` | `POST /api/migration/run-cleanup` *(admin)* (0c-5) | RAW-THROW | bare `MigrationCleanupResult {success,…,errors[]}` (NOT a Result envelope — `success` is a data field) | **no renderer call site found** |
| `migration.runV11` | `POST /api/migration/run-v11` *(admin)* (0c-5) | RAW-THROW | bare `MigrationResult {success,capturesCreated,errors[]}` | **no renderer call site found** |
| `migration.rollbackV11` | `POST /api/migration/rollback-v11` *(admin)* (0c-5) | RAW-THROW | bare `MigrationRollbackResult {success,errors[]}` | **no renderer call site found** |
| `migration.onProgress` | `/ws` channel `migration:progress` | EVENT | `(cb)=>()=>void`; payload `MigrationProgress {phase,progress,…}` | (Task 4 wiring) |

## App-level cache / device-cache (server-side metadata — stays)

| group.method | REST (0c §3) | classification | unwrap notes | call-site proof |
|---|---|---|---|---|
| `deviceCache.getAll` | `GET /api/device-cache` (0c-5) | RAW-THROW | bare `any[]` (`as CachedDeviceFile[]`) | `useUnifiedRecordings.ts:422` |
| `deviceCache.saveAll` | `PUT /api/device-cache` (0c-5) | VOID | `Promise<void>`; awaited | `useUnifiedRecordings.ts:491`; `hidock-device.ts:582` |
| `deviceCache.clear` | `DELETE /api/device-cache` (0c-5) | VOID | `Promise<void>` | (no direct renderer call site found) |

---

## EVENT subscriptions (top-level `on*` + group-nested) — all `/ws`, all `() => void` unsubscribe

| group.method | `/ws` channel (0c-1 verbatim) | classification | call-site proof |
|---|---|---|---|
| `onDomainEvent` | `domain-event` | EVENT | (subscribed in app shell; `types.ts:644`) |
| `onTranscriptionStarted` | `transcription:started` | EVENT | `useTranscriptionSync.ts:50` |
| `onTranscriptionProgress` | `transcription:progress` | EVENT | `useTranscriptionSync.ts:62` |
| `onTranscriptionCompleted` | `transcription:completed` | EVENT | `useTranscriptionSync.ts:74` |
| `onTranscriptionFailed` | `transcription:failed` | EVENT | `useTranscriptionSync.ts:86` |
| `onTranscriptionCancelled` | `transcription:cancelled` | EVENT | `useTranscriptionSync.ts:98` |
| `onTranscriptionAllCancelled` | `transcription:all-cancelled` | EVENT | `useTranscriptionSync.ts:113` |
| `onSecurityWarning` | `security-warning` | EVENT | `SecurityWarningBanner.tsx:8` |
| `onActivityLogEntry` | `activity-log:entry` | EVENT | `useDeviceSubscriptions.ts:206` |
| `onVoiceprintCaptured` | `voiceprint:captured` | EVENT | `SpeakersPanel.tsx:228` |
| `integrity.onProgress` | `integrity:progress` | EVENT | (Task 4) |
| `migration.onProgress` | `migration:progress` | EVENT | (Task 4) |
| `onRecordingAdded` | `recording:new` | **PHASE-1** | device watcher; wire to `/ws` only if Phase-1 emits it, else stub no-op unsub | `useUnifiedRecordings.ts:600` |
| `downloadService.onStateUpdate` | `download-service:state-update` | **PHASE-1 / EVENT** | device download path; stub no-op unsub unless Phase 1 present | `Device.tsx:230`; `OperationsPanel.tsx:44`; `useDownloadOrchestrator.ts:418` |

---

## PHASE-1 device groups (left as-is / stubbed; satisfy `ElectronAPI` for typecheck — Task 9)

All `jensen.*` and `downloadService.*` methods are the **browser WebUSB device path** (0c §4 — OUT of 0c).
Per 0e Pre-execution correction #4, ship as **no-op stubs**: methods `reject`/return safe defaults with a
`'device path is Phase 1'` marker; `on*` return a no-op unsubscribe. None map to a REST endpoint.

**`jensen.*` (PHASE-1, no endpoint):** `connect, tryConnect, disconnect, reset, isConnected, getModel, isP1Device,
getDeviceInfo, getCardInfo, getFileCount, getSettings, setTime, setAutoRecord, listFiles, downloadFile,
cancelDownload, deleteFile, formatCard, getRealtimeSettings, startRealtime, pauseRealtime, stopRealtime,
getRealtimeData, getBatteryStatus, startBluetoothScan, stopBluetoothScan, getBluetoothStatus` (28 methods)
+ events `onStateChanged, onConnect, onDisconnect, onDownloadProgress, onDownloadChunk, onScanProgress` (6 events).
Call sites: `hidock-device.ts`, `Device.tsx` (device path).

**`downloadService.*` (PHASE-1, no endpoint):** `getState, isFileSynced, getFilesToSync, ensureBaseline,
queueDownloads, startSession, processDownload, updateProgress, markFailed, clearCompleted, cancel, cancelAll,
retryFailed, getStats, checkStalled, cancelActive, cancelPendingDownloads, notifyCompletion` (18 methods)
+ event `onStateUpdate` (1, listed above). Call sites: `useDownloadOrchestrator.ts`, `useDeviceSubscriptions.ts`,
`useOperations.ts`, `Device.tsx`, `OperationsPanel.tsx`.

---

## Summary counts (by classification)

| Classification | Count | Notes |
|---|---|---|
| RESULT | 41 | contacts(8), voiceprints(7), speakers(9), projects(8), diarization(2), summarizationTemplates(8 of 9), meetings.update, config.get/set/updateSection(3), rag(7: status/chat/summarizeMeeting/findActionItems/cancel/removeLastMessages/clearSession/globalSearch — 8), outputs(3), transcripts.updateTurns/export(2) |
| RAW-THROW | 54 | meetings(4), recordings(getAll/getById/getForMeeting/updateStatus/linkToMeeting/getTranscriptionQueue ≈6), transcripts(4), queue(1), knowledge(3), actionables(2), assistant(getConversations/createConversation/getMessages/addMessage/getContext ≈5), chat(2), calendar(7), storage.getInfo, syncedFiles(getSyncedFile/getAll/add/getFilenames ≈4), rag(chatLegacy/stats/indexTranscript/search/getChunks ≈5), quality(6), storagePolicy(7), integrity(runScan/getReport/runStartupChecks/cleanupWronglyNamed/purgeMissingFiles ≈5), deviceCache.getAll, app.info, config.getValue, migration(varies) |
| STRING\|FALSE | 2 | recordings.transcribe, recordings.addToQueue |
| BOOL | 7 | recordings.delete, recordings.processQueue, recordings.updateQueueItem, recordings.isSummaryStale, chat.clearHistory, syncedFiles.isFileSynced, syncedFiles.remove |
| INLINE | 23 | recordings(updateRecordingStatus/updateTranscriptionStatus/deleteBatch/getCandidates/getMeetingsNearDate/selectMeeting/addExternalByPath/cancelTranscription/cancelAllTranscriptions/getTranscriptionStatus/validateTranscriptionConfig/resummarize/retryAllFailed ≈13), knowledge.update, actionables(updateStatus/generateOutput ≈2), assistant(deleteConversation/updateConversationTitle/addContext/removeContext ≈4), summarization(listModels/testConnection ≈2), summarizationTemplates.resummarizeWithTemplate, integrity(repairIssue/repairAll ≈2) |
| VOID | 3 | deviceCache.saveAll, deviceCache.clear, (recordings.updateStatus counted under RAW/VOID) |
| EVENT | 12 | (+2 PHASE-1 events) — domain/transcription×6/security/activity-log/voiceprint/integrity/migration |
| DROPPED | 11 | app.restart, recordings.addExternal, outputs.copyToClipboard, outputs.saveToFile(→download), storage.openFolder/openFile/revealInFolder/readRecording/deleteRecording/saveRecording |
| PHASE-1 | 46+ | jensen(28 methods + 6 events), downloadService(18 methods + 1 event), onRecordingAdded |

> Counts are indicative (the RAW-THROW vs INLINE split has judgment calls where the type is `Promise<any>`);
> the **per-row classification above is authoritative** for the group tasks. ~150 callable + ~14 events as the plan predicted.

## Methods with NO mapped REST endpoint (dropped/deferred)

- **DROPPED (11):** `app.restart`, `recordings.addExternal`, `outputs.copyToClipboard`,
  `storage.openFolder`, `storage.openFile`, `storage.revealInFolder`, `storage.readRecording`,
  `storage.deleteRecording`, `storage.saveRecording` (9 hard-dropped) + `outputs.saveToFile` &
  `transcripts.export` which **do** have a download endpoint but become browser-download (anchor/Blob) in the renderer.
- **PHASE-1 (no REST, stubbed):** all 28 `jensen.*` methods + 6 `jensen.on*`; all 18 `downloadService.*`
  methods + `downloadService.onStateUpdate`; `onRecordingAdded`. → **46+ methods/events** have no 0c endpoint by design.
- **Endpoints needing extra unwrap:** `recordings.getAll` (`{items,total}` → bare `.items`; `total` deferred to Task 5b);
  `quality.getByQuality` (reuses `GET /api/recordings?quality=`, not a dedicated route); `transcripts.export` /
  `outputs.saveToFile` (response is a file body, not JSON — Task 10 download path).
