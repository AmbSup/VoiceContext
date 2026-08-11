import 'package:flutter_test/flutter_test.dart';
import 'package:voice_context_mobile/main.dart';

void main() {
  testWidgets('shows the Dialog-Session entry point', (tester) async {
    await tester.pumpWidget(const VoiceContextApp());

    expect(find.text('KI Voice Context Engine'), findsOneWidget);
    expect(find.text('Session starten'), findsOneWidget);
  });
}
