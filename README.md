# KI Voice Context Engine

Persönliche KI-Kontext-Engine mit Live-Sprachdialog als Kernversprechen — siehe [CONTEXT.md](CONTEXT.md) für das Domänen-Glossar und [docs/adr/](docs/adr/) für die zentralen Architekturentscheidungen.

## Struktur

- **`mobile/`** — Flutter-App, Live-Dialog per Button-Start/Stop über die OpenAI Realtime API (WebRTC). Flutter-SDK muss lokal installiert sein, siehe `mobile/README.md`.
- **`web/`** — Next.js-App für Konfiguration, Inbox, Dokumenten-Upload, Textsuche. Kein Sprachmodus im MVP.
- **`supabase/`** — Datenbankschema (`supabase/migrations/0001_init_schema.sql`) und Projekt-Config. Supabase-CLI muss lokal installiert sein, siehe `supabase/config.toml`.
- **`docs/implementation-plan.md`** — Phasenplan von Setup bis Web-UI.
- **`docs/adr/`** — Architekturentscheidungen (aktuell: Live-Dialog als MVP-Kern, MVP-Engine-Umfang).

## Bevor irgendetwas anderes passiert

Phase 0 in `docs/implementation-plan.md`: OpenAI-EU-Data-Residency beantragen (Sales-Kontakt, nur bei Neuanlage eines Projekts konfigurierbar) und Supabase-Projekt in einer EU-Region anlegen. Beides ist langsam und blockiert alles Weitere.

## Entstehung

Dieses Konzept wurde in einer strukturierten Grilling-Session erarbeitet — die Kernbegriffe stehen in `CONTEXT.md`, die harten Architekturentscheidungen in `docs/adr/`. Neue Design-Entscheidungen sollten dort ergänzt werden, nicht nur im Code verschwinden.
