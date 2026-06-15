# AC1 — Physical P1 Plug-In Test (performed by the user, ONCE)

> **Why this is a hand-off doc:** AC1 (spec `2026-06-11-auto-pipeline-model-choice-design.md` §11) is the **sole physical-device criterion**. Per CLAUDE.md USB safety, an agent never touches the HiDock device — this checklist exists so the user can run the one clean plug-in that proves the auto-pipeline end-to-end. Every test-harness criterion (AC2–AC9) is already covered by mocked-device/mocked-HTTP suites; this is the last mile.
>
> **UI labels below are the real strings** from `apps/electron/src/pages/Settings.tsx` and `apps/electron/src/pages/Device.tsx` (verified, not invented).

## AC1 success definition (spec §11)

With ASR provider = **OpenAI Whisper**, summarization = **Ollama Cloud**, valid keys, the app open, and a baseline previously established: plugging in the P1 with N new recordings results — **with no user interaction** — in N Library rows that are synced + transcribed, with `transcription_provider = 'openai-whisper'`, `summarization_provider = 'ollama-cloud'`, and non-empty `full_text` + `summary`.

## Pre-flight (in the app, BEFORE plugging in the device)

1. **Settings → Transcription card** (`CardTitle` "Transcription"):
   - Under **"ASR Provider"**, click the **"OpenAI Whisper"** button (it becomes the highlighted/pressed button; the default is "Gemini").
   - In the **"OpenAI API Key"** field, paste your OpenAI key (it must start with `sk-`; the field placeholder reads "Enter your OpenAI API key (sk-...)"). Use the eye icon to reveal/verify it.
   - Confirm **"Transcription Model"** shows `whisper-1 (only supported model in v1)` — this select is fixed/disabled in v1.
   - Click **Save** (the button reads "Save" while dirty, "Saved" once persisted). Expect a toast: "Transcription provider set to OpenAI Whisper".

2. **Settings → Summarization card** (`CardTitle` "Summarization"):
   - Under **"Summarization Provider"**, click the **"Ollama Cloud"** button (default is "Gemini").
   - In the **"Ollama Cloud API Key"** field, paste your `ollama.com` key (link in the helper text: ollama.com/settings/keys).
   - In **"Ollama Cloud Model"**, either type a model (placeholder "e.g. gpt-oss:120b, deepseek-v3.1:671b") or click **"Fetch models"** and pick one from the list that appears.
   - Click **"Test"** — expect a success toast: "Connection OK" / "Ollama Cloud connection and model are working". (If it fails, fix the key/model before continuing.)
   - Click **Save**. Expect a toast: "Summarization provider set to Ollama Cloud".

3. **Device page** — in the device settings/config section, confirm these switches are **ON** (they are ON by default):
   - **"Auto-connect on startup"**
   - **"Auto-download recordings"**
   - **"Auto-transcribe recordings"**

4. Leave the app **running and open**. (The connect→download→transcribe pipeline runs only while the Electron app is open — spec §2.)

## The test

5. **Plug in the HiDock P1.**
   - **Expected on the FIRST-EVER connect of this device** (no prior sync history): the device activity log shows a **"Baseline established"** entry — the exact message is:
     `N existing recordings recorded as baseline — new recordings will sync automatically from now on`
     and **nothing downloads** (this is AC2's baseline behavior — the existing backlog is snapshotted, not queued).
   - If this device has been synced before, there is no baseline and it simply resumes downloading any unsynced files (AC7 grandfather behavior).

6. **Create one short test recording** on the P1 (e.g., a few seconds), so there is at least one file *outside* the baseline snapshot.

7. **Reconnect** the device (one clean reconnect — unplug, then plug back in once). With **no user interaction**, expect:
   - The new recording **downloads** automatically (synced badge).
   - It then **transcribes via OpenAI Whisper** and **summarizes via your Ollama Cloud model**.
   - The row appears in the **Library** with transcript + summary. The status badge progresses **synced → processing → complete**.

8. **Open the recording's detail panel** and verify:
   - Transcript text is present (`full_text`).
   - Summary is present (`summary`).
   - A **"Re-summarize"** action is available (re-runs Stage 2 / summarization with the currently selected LLM).

## If something fails

- The **Library header** shows an aggregate failure chip when any transcription queue rows are in the failed state: **"(N transcription[s] failed — Retry all)"** (the "Retry all" link re-pends provider-related failures). Per-row badges also surface errors.
- **Check Settings keys first.** Saving a corrected OpenAI or Ollama Cloud key **automatically re-pends** the matching failed queue items (spec §7.3), so the queue retries without manual intervention. A failed Stage 2 keeps the already-paid Whisper `full_text` (Stage-2-resumable, AC5).
- ⛔ **USB safety:** do **NOT** rapidly retry the USB connection. At most **one clean reconnect**. If you see `LIBUSB_ERROR_ACCESS`, stop and power-cycle the device per the recovery steps in `CLAUDE.md`.
- **Report what you saw** (baseline log on first connect? did the new file download/transcribe/summarize? any chip/badge errors?) so the result can be recorded against AC1.
