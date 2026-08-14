import type { CaptureState } from "./actions";

export function CaptureResultMessage({
  state,
}: {
  state: CaptureState | undefined;
}) {
  if (state?.error) {
    return (
      <p className="text-sm text-red-600 dark:text-red-400">
        {state.error}
        {state.partial &&
          ` Bereits verarbeitete Abschnitte wurden trotzdem gespeichert: ` +
            `${state.partial.memoryItemsCreated} Memory-Item(s) erstellt.`}
      </p>
    );
  }
  if (state?.success) {
    const { segmentsCreated, memoryItemsCreated, contextLinksCreated, flaggedForReviewCount } =
      state.success;
    return (
      <p className="text-sm text-green-700 dark:text-green-400">
        {segmentsCreated} Segment(e), {memoryItemsCreated} Memory-Item(s)
        erstellt
        {contextLinksCreated > 0
          ? `, ${contextLinksCreated} automatisch zugeordnet`
          : memoryItemsCreated > 0
            ? " — noch keinem Kontext zugeordnet, siehe Inbox"
            : ""}
        {flaggedForReviewCount > 0
          ? `, ${flaggedForReviewCount} möglicher Konflikt(e) zur Prüfung in der Inbox`
          : ""}
        .
      </p>
    );
  }
  return null;
}
