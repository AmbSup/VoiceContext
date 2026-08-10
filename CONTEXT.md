# KI Voice Context Engine

Persönliche KI-Kontext-Engine, die Gespräche, Dokumente und andere Quellen automatisch in ein strukturiertes, abrufbares Wissensmodell zerlegt, statt sie als Chat-Verlauf abzulegen.

## Language

**Context Space**:
Der geteilte, einladbare Besitz-Container: enthält eine oder mehrere Kontexte samt ihrer Memory-Items. Ein Nutzer besitzt eine oder mehrere Context Spaces und kann andere Nutzer zum Mitwirken einladen. Ein Nutzer kann Mitglied mehrerer Context Spaces sein (eigene und fremde).
_Avoid_: Workspace, Account (Account ist der Login, nicht der Wissens-Container)
_MVP-Hinweis_: Einladungsmechanismus ist V2 (siehe ADR 0001). Im MVP hat jede Context Space genau ein Mitglied, den Owner — Schema ist multi-user-fähig, UI/Flow noch nicht.

**Kontext** (App-Domänenbegriff, nicht zu verwechseln mit diesem CONTEXT.md als Engineering-Artefakt):
Ein vom Nutzer definierter Organisationsknoten (z. B. „Robotik", „Masterarbeit") innerhalb einer Context Space, dem Memory-Items zugeordnet werden. Bildet keinen starren Ordner-Baum, sondern ein Netz — ein Memory-Item kann mehreren Kontexten gleichzeitig angehören.

**Memory-Item**:
Die kleinste Wissenseinheit im System. Entsteht aus einem Gesprächs- oder Dokumentensegment, hat einen Typ (Fakt, Entscheidung, Aufgabe, Idee, Annahme, offene Frage, Ziel, Risiko, Person, Termin, Ergebnis, Erkenntnis), einen Status und immer eine Quelle.
_Avoid_: Note, Eintrag, Snippet

**Status** (eines Memory-Items):
Der Gültigkeitszustand: Aktiv, Überholt, Historisch, Unsicher, Geplant, Erledigt. Überholt bedeutet ersetzt durch ein neueres Memory-Item, nicht gelöscht.
_MVP-Hinweis_: Die Überholt-Erkennung ist kein eigenständiger Prozess (keine separate Conflict & Temporal Engine), sondern ein einfacher Widerspruchs-Check innerhalb der Memory Extraction selbst (siehe ADR 0002).

**Verdichtungsebene**:
Eine von mehreren Zusammenfassungsstufen eines Kontexts: Ebene 0 (Raw Knowledge, vollständig), Ebene 1 (Medium Summary / Detailed Context, ca. 2.000–5.000 Tokens), Ebene 2 (Executive Context, ca. 300–800 Tokens). Verdichtung ersetzt nie die Rohdaten.
_Avoid_: Zusammenfassung (zu unspezifisch, welche Ebene gemeint ist)

**Context Detail Router**:
Entscheidet vor einer Anfrage, welche Verdichtungsebene(n) geladen werden müssen.

**Source Router**:
Entscheidet, welche Wissensquellen für eine Anfrage herangezogen werden (Modus A–D: nur Kontext, Kontext + Modellwissen, Kontext + Internet, Deep Research).
_MVP-Hinweis_: Keine eigenständige Komponente. Modus A ist der einzige MVP-Modus; Modus B ergibt sich implizit aus der LLM-Antwort. C/D sind V2 (siehe ADR 0002).

**Entity**:
Eine erkannte Person, Organisation, Produkt o. Ä., die über mehrere Memory-Items und Gespräche hinweg als dieselbe wiedererkannt wird. Auflösung für MVP: exakter Namensabgleich + Alias-Liste; Fuzzy-Matching schlägt zusätzliche Kandidaten nur als Vorschlag vor (gleiches Vorschlag/Bestätigt-Muster wie bei [[Freigabestatus]]), automatischer Merge nur bei sehr hoher Konfidenz. Jeder Merge (auch automatische) muss rückgängig machbar sein — volle Embedding-Resolution ist V2.

**Segmentation Engine**:
Zerlegt ein vollständiges Gespräch oder Dokument nachträglich (nicht live/streaming) in thematisch abgeschlossene Segmente, aus denen Memory-Items entstehen.

**Rolle** (Context Space, pro Mitglied):
Owner (einladen/entfernen, Rechte ändern, kritische Quellen verwalten), Editor (Notizen/Memory-Items beitragen, keine Rechteverwaltung), Viewer (nur lesen, Fragen stellen).

**Sichtbarkeit** (privat/öffentlich, pro Kontext-Element):
Zusätzlich zur Freigabe eines ganzen Kontexts an Mitglieder kann ein einzelnes Memory-Item als privat markiert werden — dann bleibt es trotz geteiltem Kontext nur für den Ersteller sichtbar.
_Avoid_: Freigabe (das ist die kontextweite Einstellung, nicht die item-weite)
_MVP-Hinweis_: Keine Abstufung im MVP (folgt direkt aus dem Einladungs-Cut, siehe ADR 0001) — Feld existiert in der DB, wird aber nicht genutzt/exponiert, solange es nur den Owner gibt.

**Freigabestatus** (Vorschlag/Bestätigt):
Eigene Dimension eines Memory-Items in einer geteilten Context Space, unabhängig vom Lebenszyklus-Status (Aktiv/Überholt/…) und von der Klassifizierungs-Unsicherheit der Context Classification Engine. Gilt nur in geteilten (Multi-Member) Spaces — in einer Solo-Space entfällt der Vorschlag-Flow komplett, alles geht direkt auf Aktiv. In geteilten Spaces: Owner-Beiträge gehen direkt auf Aktiv, Editor-Beiträge starten als Vorschlag und müssen von einem Owner bestätigt werden (nicht durch den Editor selbst, auch nicht durch einen anderen Editor). Viewer tragen nicht bei.

**Inbox**:
Persönlicher Sammelort für Memory-Items, deren Zielkontext beim Erfassen nicht per Sprache bestätigt werden konnte. Kein Kontext im eigentlichen Sinn, sondern eine Warteliste zur späteren manuellen Zuordnung durch den Nutzer selbst — nie eine automatische Zuordnung durch die Classification Engine.
_Avoid_: Unsortiert, Eingangskorb

Jedes Memory-Item trägt zusätzlich zu Typ/Status/Quelle/Confidence: **Ersteller** (welches Mitglied es erzeugt hat), **Zeitpunkt**, **Sichtbarkeit**.

**Dialogzustand** (Live-Sprachmodus):
Der Live-Dialog läuft in einem von drei Zuständen: Zuhören (reine Erfassung, keine Antwort), Antworten (erkannte echte Frage, KI antwortet inhaltlich mit gezieltem Live-Retrieval), Nachfragen (KI stellt eine kurze, gezielte Rückfrage, z. B. zur Kontext-Zuordnung nach [[Inbox]]-Logik). Memory-Extraction bleibt unabhängig vom Dialogzustand immer nachgelagert (siehe Segmentation Engine), damit der Dialog flüssig bleibt.
_Avoid_: Modus (zu unspezifisch — gemeint ist konkret einer der drei Dialogzustände, nicht der Source-Router-Modus)

**Dialog-Session**:
Explizit durch Button-Druck gestartet und beendet (analog zum Sprachmodus der OpenAI-App) — kein Wake-Word, keine ambiente Dauererkennung. Solange die Session läuft, gilt alles Gesagte als an die KI gerichtet.

**Aktiver Kontext**:
Der Standard-Zielkontext für neue Memory-Items — startet als der zuletzt aktive Kontext der Vorsession. Erkennt die KI während eines laufenden [[Dialogzustand|Dialogs]] anhand des Gesprächsthemas mit hoher Konfidenz einen anderen Kontext (z. B. „Projekt A"), lädt sie dessen relevante Elemente automatisch nach und nutzt ihn für die Antwort — aber nur für diesen einen Antwortzyklus. Der Standard-Kontext selbst wechselt erst dauerhaft, wenn sich das neue Thema über mehrere Zyklen bestätigt oder der Nutzer es explizit bestätigt.
_Avoid_: aktive Space (das ist die übergeordnete Space-Auswahl, nicht die feingranulare Kontext-Erkennung innerhalb einer Session)
