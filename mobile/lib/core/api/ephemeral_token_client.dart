/// Fetches a short-lived OpenAI Realtime API token from our backend.
/// The OpenAI master key lives only on the backend — the app never sees it.
class EphemeralTokenClient {
  Future<String> fetchEphemeralToken() async {
    // TODO: call the backend endpoint (Next.js API route or Supabase Edge
    // Function) that mints an ephemeral token for the current user's
    // active Context Space.
    throw UnimplementedError('Backend token endpoint not yet built.');
  }
}
