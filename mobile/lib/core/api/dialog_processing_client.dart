import 'package:http/http.dart' as http;
import 'package:supabase_flutter/supabase_flutter.dart';

import 'ephemeral_token_client.dart' show HttpException;

/// Triggers the post-hoc Segmentation Engine / Memory Extraction / Context
/// Classification pipeline (web/src/app/api/dialog-sessions/[id]/process)
/// for a Dialog-Session right after it has ended. Runs server-side — this
/// client only fires the request and reports success/failure.
class DialogProcessingClient {
  DialogProcessingClient({String? backendBaseUrl})
      : _backendBaseUrl = backendBaseUrl ??
            const String.fromEnvironment(
              'BACKEND_BASE_URL',
              defaultValue: 'http://localhost:3000',
            );

  final String _backendBaseUrl;

  Future<void> triggerProcessing(String dialogSessionId) async {
    final session = Supabase.instance.client.auth.currentSession;
    if (session == null) {
      throw StateError('No Supabase session — user must be logged in.');
    }

    final response = await http.post(
      Uri.parse('$_backendBaseUrl/api/dialog-sessions/$dialogSessionId/process'),
      headers: {'Authorization': 'Bearer ${session.accessToken}'},
    );

    if (response.statusCode != 200) {
      throw HttpException(
        'Nachbearbeitung fehlgeschlagen (${response.statusCode}): ${response.body}',
      );
    }
  }
}
