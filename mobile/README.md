# voice_context_mobile

Flutter app scaffold for the KI Voice Context Engine. Written by hand because
the Flutter SDK isn't installed in the environment that generated this repo —
`flutter create` was never run here, so the platform folders (`android/`,
`ios/`, etc.) don't exist yet.

## First-time setup

Once the Flutter SDK is installed locally:

```
cd mobile
flutter create . --project-name voice_context_mobile --org <your-reverse-domain>
flutter pub get
```

`flutter create .` fills in the missing platform folders around the existing
`pubspec.yaml` and `lib/` without touching them.

See `docs/implementation-plan.md` at the repo root for the build order
(Phase 0 — OpenAI EU data residency and the Supabase project — has to exist
before this app can authenticate against anything).
