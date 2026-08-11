import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/api/dialog_processing_client.dart';
import '../../core/data/dialog_session_repository.dart';
import '../../core/realtime/realtime_dialog_controller.dart';

/// Button-triggered live voice session (see CONTEXT.md: "Dialog-Session").
/// No wake word — everything said while a session is active is directed
/// at the AI. Start/stop only, mirroring the OpenAI app's voice mode.
class DialogSessionScreen extends StatefulWidget {
  const DialogSessionScreen({super.key});

  @override
  State<DialogSessionScreen> createState() => _DialogSessionScreenState();
}

class _DialogSessionScreenState extends State<DialogSessionScreen> {
  final _controller = RealtimeDialogController();
  final _sessionRepository = DialogSessionRepository();
  final _dialogProcessingClient = DialogProcessingClient();
  String? _dialogSessionId;
  bool _sessionActive = false;
  bool _sessionChanging = false;

  Future<void> _toggleSession() async {
    setState(() => _sessionChanging = true);
    try {
      if (_sessionActive) {
        final transcript = _controller.transcript;
        await _controller.endSession();
        final sessionId = _dialogSessionId;
        _dialogSessionId = null;
        if (sessionId != null) {
          await _sessionRepository.endSession(
            sessionId,
            fullTranscript: transcript,
          );
          unawaited(_triggerProcessing(sessionId));
        }
      } else {
        await _controller.startSession();
        try {
          _dialogSessionId = await _sessionRepository.startSession();
        } catch (_) {
          // Don't leave a WebRTC session running that we can't record —
          // Segmentation Engine (Phase 2) needs the persisted row later.
          await _controller.endSession();
          rethrow;
        }
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Dialog-Session fehlgeschlagen: $error')),
        );
      }
    } finally {
      if (mounted) {
        setState(() {
          _sessionActive = _controller.isConnected;
          _sessionChanging = false;
        });
      }
    }
  }

  /// Fire-and-forget: the Segmentation/Extraction/Classification pipeline
  /// (docs/implementation-plan.md Phase 2, steps 4-6) is nachgelagert by
  /// design, so it must never block the "Session beendet" UX — but a
  /// failure still needs to reach the user, not vanish silently.
  Future<void> _triggerProcessing(String dialogSessionId) async {
    try {
      await _dialogProcessingClient.triggerProcessing(dialogSessionId);
    } catch (error) {
      debugPrint(
        'Nachbearbeitung fehlgeschlagen für Session $dialogSessionId: $error',
      );
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Verarbeitung der Session ist fehlgeschlagen. Die Inhalte '
              'gehen nicht verloren, bitte später erneut versuchen.',
            ),
          ),
        );
      }
    }
  }

  @override
  void dispose() {
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('KI Voice Context Engine'),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Abmelden',
            onPressed: () => Supabase.instance.client.auth.signOut(),
          ),
        ],
      ),
      body: Center(
        child: ElevatedButton.icon(
          onPressed: _sessionChanging ? null : _toggleSession,
          icon: _sessionChanging
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Icon(_sessionActive ? Icons.stop : Icons.mic),
          label: Text(
            _sessionChanging
                ? 'Verbindung wird aufgebaut …'
                : _sessionActive
                    ? 'Session beenden'
                    : 'Session starten',
          ),
        ),
      ),
    );
  }
}
