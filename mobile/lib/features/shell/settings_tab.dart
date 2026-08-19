import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import '../../core/theme/modernist_colors.dart';

/// Settings / Profil-Tab: Zeigt Benutzerinformationen und Einstellungen.
class SettingsTab extends StatefulWidget {
  const SettingsTab({super.key});

  @override
  State<SettingsTab> createState() => _SettingsTabState();
}

// Must match the entities.conversation_style check constraint in
// 20260819135221_conversation_style.sql and the keys realtime-
// instructions.ts's CONVERSATION_STYLE_INSTRUCTIONS understands.
const _conversationStyleLabels = {
  'neutral': 'Neutral',
  'coach': 'Coach',
  'denkpartner': 'Denkpartner',
};

class _SettingsTabState extends State<SettingsTab> {
  late final _supabase = Supabase.instance.client;
  late final _user = _supabase.auth.currentUser;
  String? _displayName;
  String _conversationStyle = 'neutral';
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  Future<void> _loadProfile() async {
    final userId = _user?.id;
    if (userId == null) {
      setState(() => _loading = false);
      return;
    }
    final row = await _supabase
        .from('profiles')
        .select('display_name, conversation_style')
        .eq('id', userId)
        .maybeSingle();
    if (!mounted) return;
    setState(() {
      _displayName = row?['display_name'] as String?;
      _conversationStyle =
          row?['conversation_style'] as String? ?? 'neutral';
      _loading = false;
    });
  }

  Future<void> _editDisplayName() async {
    final controller = TextEditingController(text: _displayName ?? '');
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Name'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'Dein Vorname'),
          onSubmitted: (value) => Navigator.of(context).pop(value.trim()),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Abbrechen'),
          ),
          TextButton(
            onPressed: () => Navigator.of(context).pop(controller.text.trim()),
            child: const Text('Speichern'),
          ),
        ],
      ),
    );
    if (result == null || result == _displayName) return;

    final userId = _user?.id;
    if (userId == null) return;
    await _supabase
        .from('profiles')
        .update({'display_name': result.isEmpty ? null : result})
        .eq('id', userId);
    if (!mounted) return;
    setState(() => _displayName = result.isEmpty ? null : result);
  }

  Future<void> _editConversationStyle() async {
    final result = await showDialog<String>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Gesprächsstil'),
        children: _conversationStyleLabels.entries
            .map(
              (entry) => RadioListTile<String>(
                value: entry.key,
                groupValue: _conversationStyle,
                title: Text(entry.value),
                onChanged: (value) => Navigator.of(context).pop(value),
              ),
            )
            .toList(),
      ),
    );
    if (result == null || result == _conversationStyle) return;

    final userId = _user?.id;
    if (userId == null) return;
    await _supabase
        .from('profiles')
        .update({'conversation_style': result})
        .eq('id', userId);
    if (!mounted) return;
    setState(() => _conversationStyle = result);
  }

  @override
  Widget build(BuildContext context) {
    return SingleChildScrollView(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Header mit Profilbild & Name
          Card(
            color: ModernistColors.bg,
            elevation: 0,
            shape: RoundedRectangleBorder(
              side: const BorderSide(
                color: ModernistColors.divider,
                width: 2,
              ),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  // Avatar
                  Container(
                    width: 80,
                    height: 80,
                    decoration: BoxDecoration(
                      color: ModernistColors.accent,
                      shape: BoxShape.circle,
                    ),
                    child: const Center(
                      child: Icon(
                        Icons.person,
                        size: 40,
                        color: ModernistColors.bg,
                      ),
                    ),
                  ),
                  const SizedBox(height: 16),
                  // Name — tippen zum Bearbeiten. Der Live-Dialog-Agent
                  // liest genau dieses Feld (profiles.display_name) für
                  // seine Begrüßung, siehe realtime_dialog_controller.dart.
                  InkWell(
                    onTap: _editDisplayName,
                    borderRadius: BorderRadius.circular(4),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 4,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            _loading
                                ? '…'
                                : (_displayName?.isNotEmpty ?? false)
                                    ? _displayName!
                                    : 'Name hinzufügen',
                            style: const TextStyle(
                              fontSize: 20,
                              fontWeight: FontWeight.w800,
                              letterSpacing: 0.5,
                              color: ModernistColors.text,
                            ),
                          ),
                          const SizedBox(width: 6),
                          const Icon(
                            Icons.edit,
                            size: 16,
                            color: ModernistColors.textMuted,
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(height: 12),
                  // Email
                  Text(
                    _user?.email ?? 'user@example.com',
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: ModernistColors.textMuted,
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 28),
          // Einstellungen Sektion
          const Text(
            'EINSTELLUNGEN',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: ModernistColors.textMuted,
            ),
          ),
          const SizedBox(height: 12),
          // Gesprächsstil — steuert Ton und Nachfrage-Häufigkeit der
          // Live-Dialog-KI, siehe realtime-instructions.ts
          // CONVERSATION_STYLE_INSTRUCTIONS.
          _SettingItem(
            icon: Icons.forum,
            label: 'Gesprächsstil',
            value: _conversationStyleLabels[_conversationStyle] ?? 'Neutral',
            onTap: _editConversationStyle,
          ),
          const SizedBox(height: 12),
          // Sprache
          _SettingItem(
            icon: Icons.language,
            label: 'Sprache',
            value: 'Deutsch',
            onTap: () {
              // TODO: Sprachauswahl implementieren
            },
          ),
          const SizedBox(height: 12),
          // Benachrichtigungen
          _SettingItem(
            icon: Icons.notifications,
            label: 'Benachrichtigungen',
            value: 'Aktiviert',
            onTap: () {
              // TODO: Benachrichtigungseinstellungen
            },
          ),
          const SizedBox(height: 12),
          // Datenschutz
          _SettingItem(
            icon: Icons.privacy_tip,
            label: 'Datenschutz & Sicherheit',
            value: 'Info',
            onTap: () {
              // TODO: Datenschutzrichtlinien öffnen
            },
          ),
          const SizedBox(height: 32),
          // Über Sektion
          const Text(
            'ÜBER',
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w800,
              letterSpacing: 0.8,
              color: ModernistColors.textMuted,
            ),
          ),
          const SizedBox(height: 12),
          // Version
          _SettingItem(
            icon: Icons.info,
            label: 'App-Version',
            value: 'v4',
            onTap: () {},
            trailing: null,
          ),
          const SizedBox(height: 32),
          // Abmelden Button
          SizedBox(
            width: double.infinity,
            child: ElevatedButton.icon(
              onPressed: () async {
                await Supabase.instance.client.auth.signOut();
                if (mounted) {
                  Navigator.of(context).pushNamedAndRemoveUntil(
                    '/auth',
                    (route) => false,
                  );
                }
              },
              icon: const Icon(Icons.logout),
              label: const Text('ABMELDEN'),
              style: ElevatedButton.styleFrom(
                backgroundColor: ModernistColors.accent,
                foregroundColor: ModernistColors.bg,
                padding: const EdgeInsets.symmetric(vertical: 12),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Hilfswidge für Einstellungszeilen
class _SettingItem extends StatelessWidget {
  final IconData icon;
  final String label;
  final String value;
  final VoidCallback onTap;
  final Widget? trailing;

  const _SettingItem({
    required this.icon,
    required this.label,
    required this.value,
    required this.onTap,
    this.trailing,
  });

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            border: Border.all(
              color: ModernistColors.divider,
              width: 1,
            ),
            borderRadius: BorderRadius.circular(8),
          ),
          child: Row(
            children: [
              Icon(icon, color: ModernistColors.accent, size: 20),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      label,
                      style: const TextStyle(
                        fontSize: 14,
                        fontWeight: FontWeight.w700,
                        color: ModernistColors.text,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      value,
                      style: const TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w500,
                        color: ModernistColors.textMuted,
                      ),
                    ),
                  ],
                ),
              ),
              trailing ??
                  const Icon(
                    Icons.chevron_right,
                    color: ModernistColors.textMuted,
                    size: 20,
                  ),
            ],
          ),
        ),
      ),
    );
  }
}
