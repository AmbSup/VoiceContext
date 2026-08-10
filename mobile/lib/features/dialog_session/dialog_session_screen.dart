import 'package:flutter/material.dart';

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
  bool _sessionActive = false;

  Future<void> _toggleSession() async {
    if (_sessionActive) {
      await _controller.endSession();
    } else {
      await _controller.startSession();
    }
    setState(() => _sessionActive = !_sessionActive);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('KI Voice Context Engine')),
      body: Center(
        child: ElevatedButton.icon(
          onPressed: _toggleSession,
          icon: Icon(_sessionActive ? Icons.stop : Icons.mic),
          label: Text(_sessionActive ? 'Session beenden' : 'Session starten'),
        ),
      ),
    );
  }
}
