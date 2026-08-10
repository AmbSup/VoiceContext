# MVP-Engine-Umfang: Kernschleife statt aller zehn Engines

Das Konzept beschreibt zehn Engines (Segmentation, Memory Extraction, Context Classification, Entity & Relationship, Consolidation, Context Detail Router, Source Router, Retrieval, Conflict & Temporal, Answer Engine). Für den MVP wird nur die Kernschleife "aufnehmen → verstehen → speichern → präzise wiederfinden" gebaut, ergänzt um den Live-Dialog aus [ADR 0001](./0001-live-dialog-mvp.md).

**Enthalten**: Segmentation, Memory Extraction (inkl. einfacher Konflikt-Erkennung, siehe unten), Context Classification (regelbasiert + leichtes Modell, nicht voll autonom — schreibt nie automatisch in geteilte Spaces), Entity & Relationship (Erkennung + Auflösung über exakten Match + Alias-Liste + manuell bestätigte Fuzzy-Vorschläge, kein Graph), Retrieval/RAG (einfache Form, plus Live-Abfragepfad für den Dialog), Answer Engine, Permission Engine (Rollen/Sichtbarkeit im Schema vorbereitet, aber nicht aktiviert, siehe ADR 0001).

**Gestrichen bzw. eingefaltet**:
- Consolidation Engine und Context Detail Router entfallen — keine mehrstufigen Verdichtungsebenen im MVP, nur Rohdaten (Ebene 0) plus einfaches Retrieval.
- Source Router entfällt als eigenständige Komponente — Modus A (nur persönlicher Kontext) ist der einzige MVP-Modus, Modus B (Kontext + Modell-Reasoning) ergibt sich implizit aus der LLM-Antwort. Internet-/Deep-Research-Modi (C/D) sind V2.
- Conflict & Temporal Engine wird kein eigenständiger Prozess, sondern ein einfacher Check innerhalb der Memory Extraction: erkennt ein neues Item einen Widerspruch zu einem aktiven alten Item im selben Kontext, wird das alte als Überholt markiert.

GraphRAG und volle Embedding-basierte Entity-Resolution sind V2.
