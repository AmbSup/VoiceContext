import 'package:flutter/material.dart';

import 'features/dialog_session/dialog_session_screen.dart';

void main() {
  // TODO(phase 0): Supabase.initialize(url: ..., anonKey: ...) once the
  // EU-region Supabase project from docs/implementation-plan.md exists.
  runApp(const VoiceContextApp());
}

class VoiceContextApp extends StatelessWidget {
  const VoiceContextApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'KI Voice Context Engine',
      theme: ThemeData(colorSchemeSeed: Colors.indigo, useMaterial3: true),
      home: const DialogSessionScreen(),
    );
  }
}
