# Implementierungsplan

Grundlage: [CONTEXT.md](../CONTEXT.md), [ADR 0001](adr/0001-live-dialog-mvp.md), [ADR 0002](adr/0002-mvp-engine-scope.md).

## Phase 0 — Setup (blockierend, zuerst)

- **OpenAI EU-Data-Residency beantragen.** Erfordert Sales-Kontakt bei OpenAI und wird nur bei Neuanlage eines Projekts konfiguriert (kein Nachrüsten möglich) — das ist der langsamste Schritt im ganzen Plan, deshalb zuerst anstoßen, bevor irgendein anderer Integrationscode entsteht.
- Supabase-Projekt ebenfalls in einer EU-Region anlegen (z. B. Frankfurt) — die OpenAI-EU-Residency allein nützt nichts, wenn die Daten dann in einer US-Supabase-Instanz landen.
- Tracing für die Realtime API deaktivieren (laut Recherche nicht EU-residency-konform).
- Monorepo-Grundstruktur: `web/` (Next.js), `mobile/` (Flutter), `supabase/` (Migrationen + Config).

## Phase 1 — Datenschicht

- Schema umsetzen (siehe `supabase/migrations/0001_init_schema.sql`): Context Spaces, Kontexte, Memory-Items, Entities, Segmente, Dokumente.
- `pgvector`-Extension aktivieren, Embedding-Spalte auf `memory_items`.
- Supabase Auth einrichten, RLS-Policies nach Context-Space-Mitgliedschaft (funktioniert unverändert weiter, wenn in V2 mehrere Mitglieder aktiviert werden).

## Phase 2 — Live-Dialog-Kernschleife (der eigentliche Wow-Effekt, siehe ADR 0001)

1. Flutter-App: Button startet/beendet eine Dialog-Session (kein Wake-Word).
2. App verbindet sich per WebRTC direkt mit der OpenAI Realtime API; Backend stellt vorher ein Ephemeral Token aus (nie den Master-Key in die App).
3. Realtime-Session nutzt Function-Calling für die drei Dialogzustände: Zuhören, Antworten (mit gezieltem Live-Retrieval, siehe Phase 3), Nachfragen (kurze Rückfrage, z. B. bei unsicherer Kontext-Zuordnung).
4. Nach Sessionende (nachgelagert, nicht live): Segmentation Engine zerlegt das volle Transkript in thematische Segmente.
5. Memory Extraction erzeugt daraus Memory-Items — inklusive einfachem Widerspruchs-Check gegen aktive Items im selben Kontext (Treffer → altes Item auf `ueberholt` setzen, `superseded_by_id` verlinken).
6. Context Classification schlägt Kontext(e) pro Memory-Item vor; bei hoher Konfidenz automatisch, sonst Inbox (nie automatische Zuordnung bei Unsicherheit).

## Phase 3 — Retrieval & Answer

- Embeddings (OpenAI, EU-Endpoint) für jedes Memory-Item.
- Retrieval: Vektorsuche + strukturierte Filter (Kontext, Typ, Status, Datum) — kein Graph, kein Source Router als eigene Komponente (Modus A ist Standard, siehe ADR 0002).
- Live-Pfad: während der Dialog-Session löst eine erkannte echte Frage einen gezielten Retrieval-Call aus (Function-Call in der Realtime-Session), nicht den vollen Batch-Pfad.
- **Aktiver Kontext**: Default = zuletzt aktiver Kontext; bei erkanntem Themenwechsel mit hoher Konfidenz temporärer Fokuswechsel nur für den jeweiligen Antwortzyklus, dauerhafter Wechsel erst nach Bestätigung über mehrere Zyklen.

## Phase 4 — Entities

- Erkennung von Personen/Organisationen/Produkten pro Memory-Item.
- Auflösung: exakter Namensabgleich + Alias-Liste; Fuzzy-Matching liefert nur Vorschläge zur manuellen Bestätigung; automatischer Merge nur bei sehr hoher Konfidenz.
- Jeder Merge (auch automatisch) muss über `entities.merged_into_entity_id` rückgängig machbar sein.

## Phase 5 — Web-UI (Next.js)

- Auth, Context-Space-/Kontext-Verwaltung.
- Inbox: manuelle Zuordnung unsicherer Memory-Items.
- Dokumenten-Upload und manuelle Text-Eingabe als gleichwertige Inputs zur Segmentation/Extraction-Pipeline (kein separater Voice-Modus im Web-UI für MVP, siehe Q9).
- Text-basierte Suche/Answer-UI über dieselbe Retrieval-Engine.

## Explizit V2 (nicht Teil dieses Plans)

Consolidation Engine / Verdichtungsebenen 1–2, Context Detail Router, Source-Router-Modi C/D (Internet, Deep Research), GraphRAG, volle Embedding-Entity-Resolution, Einladungs-/Sharing-Aktivierung (Schema ist bereit, UI/Flow fehlt), Web-UI-Sprachmodus, App-Store-Vertrieb.
