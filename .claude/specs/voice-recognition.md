# Voice Recognition in Chat

## Goal
Let a user dictate their chat question by voice instead of (or in addition
to) typing it, using a locally-hosted, offline Vosk speech-to-text model -
no audio ever leaves the self-hosted deployment.

## Requirements
- ChatPage shows a microphone control near the message input that starts
  and stops a browser-side audio recording.
- On stop, the recorded clip is sent to a new backend endpoint as a single
  file (record-then-send, not a live streaming/WebSocket transcription).
- The backend transcribes the clip using a single Vosk model whose location
  is set via backend config (one active language/model per deployment -
  no in-UI language switcher or multi-model selection in this version).
- Model files are never bundled with the app or committed to git - an
  operator downloads and unzips a model themselves into
  `backend/data/vosk_models/` (already `.gitignore`d), and the config
  points at it. README must document this as a manual setup step,
  including where to get a model and which languages are available.
- The recording control clearly reflects state: idle, recording, and
  transcribing (waiting on the backend) are visibly distinct.
- On successful transcription, the resulting text is placed into the chat's
  message input field for the user to review/edit - it is never sent to
  the chat automatically.
- If no Vosk model is configured or loadable on the backend, attempting to
  transcribe returns a clear, specific error surfaced to the user (e.g.
  "voice recognition model not installed") - never a silent failure or an
  unhandled crash.

## Acceptance Criteria
- [ ] A microphone control is visible on the ChatPage next to the message
      input.
- [ ] Clicking it starts recording with a visible "recording" state;
      stopping it sends the captured audio to the backend and the UI shows
      a distinct "transcribing" state until a result (or error) comes
      back.
- [ ] On success, the transcribed text appears in the message input box,
      editable, and no message is sent automatically.
- [ ] With no model configured/loaded, using the microphone control
      surfaces a specific "model not installed" style error, not a crash
      or a generic/unlabeled failure.
- [ ] Placing a downloaded model under `backend/data/vosk_models/` and
      pointing config at it makes voice input work with no code change.
- [ ] End-to-end voice input is verified working for Russian using
      `vosk-model-small-ru-0.22` as the reference model.
- [ ] README documents the feature and the manual model-install steps
      (where to download a model, where to place it, which config points
      at it).

## Non-Goals
- Real-time/streaming transcription while the user is still speaking -
  the model only sees the audio after recording stops.
- Multiple simultaneously-loaded models or an in-chat language switcher -
  one configured model per deployment.
- Auto-sending the transcribed message without user review.
- Shipping/committing any model files in the repo or Docker image.
- Text-to-speech or any other voice *output* - input direction only.
- Wake-word or hands-free/always-listening capture.

## Open Questions
- Exact backend config shape for the active model (e.g. a single
  `VOSK_MODEL_PATH` setting) - left for the plan.
- Whether captured audio needs a hard duration/size cap before upload.
- If the user already has a partial draft typed, does transcribed text
  replace the input box or insert at the cursor/append?
- Whether the mic control is hidden entirely when no model is configured,
  or always visible and only errors on use.
