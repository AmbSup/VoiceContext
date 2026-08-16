import 'package:supabase_flutter/supabase_flutter.dart';

/// Persists the Dialog-Session row (start/end + transcript) so a later,
/// server-side Segmentation Engine has something to work from (see
/// docs/implementation-plan.md Phase 2, step 4). The transcript itself is
/// assembled by RealtimeDialogController from Realtime server events.
class DialogSessionRepository {
  DialogSessionRepository({SupabaseClient? client})
      : _client = client ?? Supabase.instance.client;

  final SupabaseClient _client;

  /// MVP: every user owns exactly one Context Space (see
  /// supabase/migrations/0004_bootstrap_context_space.sql), so it's
  /// resolved directly here rather than asking the user to pick one —
  /// Context-Space-Verwaltung (Phase 5) will replace this lookup.
  Future<String> startSession({String? startedContextId}) async {
    final userId = _client.auth.currentUser!.id;

    final contextSpace = await _client
        .from('context_spaces')
        .select('id')
        .eq('owner_id', userId)
        .single();

    final row = await _client
        .from('dialog_sessions')
        .insert({
          'context_space_id': contextSpace['id'] as String,
          'user_id': userId,
          if (startedContextId != null) 'started_context_id': startedContextId,
        })
        .select('id')
        .single();

    return row['id'] as String;
  }

  Future<void> endSession(String dialogSessionId,
      {String? fullTranscript}) async {
    await _client.from('dialog_sessions').update({
      'ended_at': DateTime.now().toUtc().toIso8601String(),
      if (fullTranscript != null && fullTranscript.isNotEmpty)
        'full_transcript': fullTranscript,
    }).eq('id', dialogSessionId);
  }

  /// Persists RealtimeDialogController.eventLog for debugging live-dialog
  /// issues (VAD-triggered interruptions, token usage over a session) — see
  /// supabase/migrations/0012_dialog_session_events.sql. Text/JSON only,
  /// the controller already filtered out raw-audio-bearing events before
  /// this is called.
  Future<void> logEvents(
    String dialogSessionId,
    List<Map<String, dynamic>> events,
  ) async {
    if (events.isEmpty) return;

    final session = await _client
        .from('dialog_sessions')
        .select('context_space_id')
        .eq('id', dialogSessionId)
        .single();
    final contextSpaceId = session['context_space_id'] as String;

    final rows = [
      for (var i = 0; i < events.length; i++)
        {
          'context_space_id': contextSpaceId,
          'dialog_session_id': dialogSessionId,
          'sequence': i,
          'event_type': events[i]['type'] as String? ?? 'unknown',
          'payload': events[i],
        },
    ];
    await _client.from('dialog_session_events').insert(rows);
  }

  /// Persists RealtimeDialogController.voiceTurnLatenciesMs — the
  /// speech-stopped-to-first-audio-byte latency the user actually feels,
  /// which never touches our backend (audio flows client<->OpenAI directly
  /// over WebRTC) and so is invisible to the performance_logs rows the
  /// Next.js API routes write themselves. Reuses that same table (route:
  /// "voice_turn_latency") so both halves of the live-dialog latency story
  /// show up together.
  Future<void> logVoiceTurnLatencies(
    String dialogSessionId,
    List<int> latenciesMs,
  ) async {
    if (latenciesMs.isEmpty) return;

    final session = await _client
        .from('dialog_sessions')
        .select('context_space_id')
        .eq('id', dialogSessionId)
        .single();
    final contextSpaceId = session['context_space_id'] as String;

    final rows = [
      for (final ms in latenciesMs)
        {
          'context_space_id': contextSpaceId,
          'dialog_session_id': dialogSessionId,
          'route': 'voice_turn_latency',
          'total_ms': ms,
        },
    ];
    await _client.from('performance_logs').insert(rows);
  }
}
