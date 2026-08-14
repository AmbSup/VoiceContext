// Display labels/colors for memory_items.type/status/confidence — see
// CONTEXT.md "Memory-Item" and "Status" for the domain definitions, and
// supabase/migrations/0001_init_schema.sql for the underlying check
// constraints these maps must stay in sync with.

export const MEMORY_ITEM_TYPE_LABELS: Record<string, string> = {
  fakt: "Fakt",
  entscheidung: "Entscheidung",
  aufgabe: "Aufgabe",
  idee: "Idee",
  annahme: "Annahme",
  offene_frage: "Offene Frage",
  ziel: "Ziel",
  risiko: "Risiko",
  person: "Person",
  termin: "Termin",
  ergebnis: "Ergebnis",
  erkenntnis: "Erkenntnis",
};

export const MEMORY_ITEM_STATUS_LABELS: Record<string, string> = {
  aktiv: "Aktiv",
  ueberholt: "Überholt",
  historisch: "Historisch",
  unsicher: "Unsicher",
  geplant: "Geplant",
  erledigt: "Erledigt",
};

export const MEMORY_ITEM_STATUS_CLASSES: Record<string, string> = {
  aktiv:
    "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  ueberholt:
    "bg-zinc-200 text-zinc-600 line-through dark:bg-zinc-800 dark:text-zinc-400",
  historisch: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  unsicher:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  geplant: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  erledigt:
    "bg-zinc-200 text-zinc-500 line-through dark:bg-zinc-800 dark:text-zinc-500",
};

export const MEMORY_ITEM_CONFIDENCE_LABELS: Record<string, string> = {
  niedrig: "Niedrige Konfidenz",
  mittel: "Mittlere Konfidenz",
  hoch: "Hohe Konfidenz",
};

// memory_conflict_reviews.verdict — see supabase/migrations/
// 0014_conflict_review.sql and web/src/lib/pipeline.ts's conflict
// classifier.
export const MEMORY_CONFLICT_VERDICT_LABELS: Record<string, string> = {
  duplikat: "Duplikat",
  widerspruch: "Widerspruch",
  ersetzt_veraltet: "Ersetzt/veraltet",
};

export function formatMemoryItemType(type: string): string {
  return MEMORY_ITEM_TYPE_LABELS[type] ?? type;
}

export function formatMemoryItemStatus(status: string): string {
  return MEMORY_ITEM_STATUS_LABELS[status] ?? status;
}

export function memoryItemStatusClasses(status: string): string {
  return (
    MEMORY_ITEM_STATUS_CLASSES[status] ??
    "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
  );
}

export function formatMemoryItemConfidence(
  confidence: string | null,
): string | null {
  if (!confidence) return null;
  return MEMORY_ITEM_CONFIDENCE_LABELS[confidence] ?? confidence;
}

export function formatConflictVerdict(verdict: string): string {
  return MEMORY_CONFLICT_VERDICT_LABELS[verdict] ?? verdict;
}
