import '../api/ephemeral_token_client.dart';

/// Owns one Dialog-Session's WebRTC connection to the OpenAI Realtime API.
///
/// Architecture (see docs/implementation-plan.md, Phase 2 / ADR 0001):
/// - Connects directly from this app to OpenAI over WebRTC for low latency.
/// - Never embeds the OpenAI master key — fetches a short-lived ephemeral
///   token from our own backend first (EphemeralTokenClient).
/// - Backend handles user/context-space/token concerns; audio never
///   passes through the backend.
/// - Realtime session exposes three Dialogzustand states via function
///   calling: zuhoeren, antworten (with targeted live retrieval),
///   nachfragen. Memory extraction itself stays post-session (batch).
class RealtimeDialogController {
  final _tokenClient = EphemeralTokenClient();

  Future<void> startSession() async {
    final realtimeToken = await _tokenClient.fetchEphemeralToken();
    // TODO: open a WebRTC peer connection to OpenAI's Realtime endpoint
    // (EU-residency routed) using realtimeToken.token, and register the
    // zuhoeren/antworten/nachfragen tool handlers (see CONTEXT.md).
  }

  Future<void> endSession() async {
    // TODO: close the WebRTC connection; backend persists the session's
    // full transcript for the (nachgelagert) Segmentation Engine to pick up.
  }
}
