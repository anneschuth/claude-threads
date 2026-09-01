# Audio transcription: voice notes → text before Claude sees them

Upstream discussion: anneschuth/claude-threads#519.

## What it does

When an inbound attachment has an `audio/*` MIME type and `transcription` is
configured, the bot transcribes it and puts the text into the message Claude
receives. Today the attachment is only saved to disk and listed by path — a
`.webm` Claude cannot hear. With this feature a Slack audio clip (or any
uploaded audio file) becomes a spoken message.

Behaviour, in order:

1. `saveFilesToUploadDir` runs unchanged — the file lands on disk and its
   path is still listed in the `[Attached files from chat …]` header.
2. Every saved file whose `mimeType` starts with `audio/` — or whose
   extension is a known audio one (`m4a mp3 ogg opus wav aac flac`) when the
   platform reported only a generic type — is sent to the configured
   transcriber. Files are transcribed sequentially.
3. The prompt gains one block per transcript, after the file list and before
   the user's own text:

   ```
   [Transcript of voice.webm (elevenlabs):]
   <text>
   ```

4. The bot posts each transcript back into the thread/channel as a quote
   (`🎙️ Transcript of voice.webm:` + every line blockquoted — a bare `>` on
   the first line only breaks at the first pause in speech). Teammates and
   the audit log see what Claude heard; a bad transcript is visible before
   Claude acts on it.
5. A transcription failure is reported through the existing skipped-files
   feedback (`⚠️ Some files could not be processed`) with reason
   `Transcription failed: <message>` and the note that the raw file was still
   handed to Claude. Never silent, never fatal to the message.
6. No `transcription` block in config → nothing changes. Non-audio files are
   untouched.

Out of scope for round 1: starting a session from a voice note (the first
message still needs the typed @-mention), `video/*`, Slack's own async
transcript, streaming/realtime.

## Config (top-level)

```yaml
transcription:
  provider: elevenlabs      # the only provider in round 1
  apiKey: ...               # ElevenLabs key; 0600 file, never in a repo
  model: scribe_v2          # optional, default scribe_v2
  languageCode: hrv         # optional; passed through verbatim (ElevenLabs
                            # accepts ISO-639-1 and -3); omitted = auto-detect
```

Validation happens at boot: an unknown `provider` or a missing `apiKey` is a
config error and the daemon does not start. One key per daemon — the provider
is a property of the deployment, not of a chat platform, and it applies to
Slack and Mattermost alike.

## Provider interface

```ts
// src/transcription/types.ts
interface Transcriber {
  readonly provider: string;
  transcribe(input: { path: string; mimeType: string; name: string }): Promise<string>;
}
createTranscriber(config: TranscriptionConfig): Transcriber   // src/transcription/index.ts
```

`ElevenLabsTranscriber` (`src/transcription/elevenlabs.ts`) POSTs multipart
`file` + `model_id` (+ `language_code` when set) to
`https://api.elevenlabs.io/v1/speech-to-text` with header `xi-api-key`, 120 s
timeout, and returns `text` from the JSON body. A non-2xx response or an
empty `text` is an error with the HTTP status and the first 200 chars of the
body. No SDK: `fetch` + `FormData` on Bun/Node 20. `fetch` is injectable for
tests.

## Wiring

- `Config.transcription?: TranscriptionConfig` (`src/config/types.ts`).
- `index.ts`: `createTranscriber(config.transcription)` once at boot, then
  `sessionManager.setTranscriber(t)`.
- `SessionManager` passes it as the new last parameter of
  `streaming.buildMessageContent(text, platform, uploadDir, files, debug, transcriber?)`.
- `BuiltMessageContent.transcripts?: Transcript[]` (`{ name, text }`).
- `postTranscriptFeedback(platform, threadId, transcripts)` next to
  `postSkippedFilesFeedback`, called at the same three places that post
  skipped-file feedback for a user message with files: follow-up
  (`message-manager.ts`), session start (`lifecycle.ts`), context-prompt
  resolution (`context-prompt/handler.ts`).
- **Build once.** The session-start path used to build the message content
  (downloading every attachment) and then hand the *built* text plus the
  same files to `offerContextPrompt`, whose send paths build again — double
  download, duplicated file header, and now a double transcription and echo.
  `startSession` now passes the raw prompt and files into
  `offerContextPrompt` and builds only on the fallback path. Behaviour for
  direct-channel-mode sessions (the fallback path) is unchanged.

- **The deferred context prompt keeps its files.** When the user answers
  the "include thread context?" prompt with a reaction, the completion event
  carries only simplified file refs; the original `PlatformFile[]` were
  parked in the context-prompt module. The lifecycle listener now takes them
  from there (`takeContextPromptFiles`) and builds with them, posting the
  usual skipped-file and transcript feedback. Before, attachments on that
  path survived only because the pre-built file header rode along in the
  queued prompt text, which the once-only build removed. Regression test in
  `lifecycle.test.ts`.

Known, pre-existing, out of scope: the worktree-prompt skip adapters
(`reaction-router.ts`, `manager.ts` worktree skip) still drop queued files.
Direct-channel-mode task channels never take that path.

## Tests

- `elevenlabs.test.ts`: sends the file and model as multipart with the key
  header; includes `language_code` only when configured; returns `text`;
  throws on non-2xx with status and body excerpt; throws on empty text.
- `index.test.ts`: factory returns an ElevenLabs transcriber; rejects unknown
  provider; rejects missing key.
- `handler.test.ts` (streaming): audio attachment produces a transcript block
  and a `transcripts` entry; non-audio attachment is not transcribed; no
  transcriber means no transcript; transcriber failure surfaces in `skipped`
  and the file path stays in the header; `postTranscriptFeedback` posts one
  quote per transcript and nothing when empty.

## Decisions

| Decision | Why |
|---|---|
| Top-level config, not per-platform | one vendor key per daemon; the question is open upstream (#519) and the shape can move if Anne prefers per-platform |
| Transcript echoed to the thread by default | the whole point of the Slack surface is that teammates see the task; a silent transcript hides the one step most likely to be wrong |
| Keep the raw file in the prompt | Claude may want the audio itself later (e.g. to re-transcribe with a hint), and it costs nothing |
| Failure = warning, message still sent | fail loud, but a bad vendor day must not eat a teammate's message |
| `audio/*` only, plus an audio-extension fallback for generic MIME types | Slack audio clips are `audio/webm`; a client that reports `application/octet-stream` for a `.m4a` still gets transcribed; video is a separate question asked upstream |
| Flat config keys (`apiKey`, `model` beside `provider`) rather than nested per provider | one provider today; #519 asks the maintainer which shape they want and the move is mechanical |
| Transcript is framed with a bracket header like the file list, not XML tags | it is the sender's own message, exactly as trusted as typed text from the same user; a reviewer suggested XML "boundaries", but the file-list header sets the house style and Claude already treats the block as user content |
| ElevenLabs error bodies are parsed for `detail.message` | the raw JSON in a thread warning is noise; the status code and a body excerpt remain the fallback |

## Review notes (2026-09-02)

Gemini flagged `scribe_v2` as non-existent and `language_code` as ISO-639-1
only; a grounded web search the same day listed `scribe_v2` as current, and
the Telegram bot on the same box has run `hrv` (ISO-639-3) in production for
weeks. Both settled against the live API at deploy time; both are
configurable if the default is ever wrong. Codex found no design flaw beyond
the once-only build and the pre-existing file-loss paths recorded above.
