# voice_context_mobile

Flutter app scaffold for the KI Voice Context Engine. The Android and iOS
platform projects are generated and the Realtime Dialog-Session connects
directly to OpenAI over WebRTC with a short-lived client secret.

## First-time setup

```
cd mobile
flutter pub get
```

Requires the EU-region Supabase project's URL and anon key, plus
`BACKEND_BASE_URL` when the token backend is not running on localhost:

```
flutter run \
  --dart-define=SUPABASE_URL=https://xxxx.supabase.co \
  --dart-define=SUPABASE_ANON_KEY=... \
  --dart-define=BACKEND_BASE_URL=https://example.com
```

Without `SUPABASE_URL`/`SUPABASE_ANON_KEY` the app fails at startup —
`Supabase.initialize` in `lib/main.dart` requires both. The app shows a
login screen (email+password) until a session exists; `EphemeralTokenClient`
(`core/api`) needs that session to mint a Realtime token.

The backend response supplies the OpenAI Realtime signaling URL, so an
`OPENAI_API_BASE_URL` configured for EU data residency is also used by the
mobile WebRTC connection.

See `docs/implementation-plan.md` at the repo root for the build order
(Phase 0 — OpenAI EU data residency and the Supabase project — has to exist
before this app can authenticate against anything).
