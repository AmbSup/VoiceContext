import 'package:supabase_flutter/supabase_flutter.dart';

class ContextSummary {
  const ContextSummary({
    required this.id,
    required this.name,
    required this.itemCount,
    required this.isActive,
  });

  final String id;
  final String name;
  final int itemCount;
  final bool isActive;
}

class ContextSummaryRepository {
  ContextSummaryRepository({SupabaseClient? client})
      : _client = client ?? Supabase.instance.client;

  final SupabaseClient _client;

  Future<List<ContextSummary>> fetchSummaries() async {
    final userId = _client.auth.currentUser!.id;
    final contextSpace = await _client
        .from('context_spaces')
        .select('id')
        .eq('owner_id', userId)
        .single();
    final contextSpaceId = contextSpace['id'] as String;
    final preference = await _client
        .from('active_context_preferences')
        .select('default_context_id')
        .eq('context_space_id', contextSpaceId)
        .eq('user_id', userId)
        .maybeSingle();
    final activeContextId = preference?['default_context_id'] as String?;
    final rows = await _client
        .from('contexts')
        .select('id, name, memory_context_links(count)')
        .eq('context_space_id', contextSpaceId)
        .order('created_at');

    return rows.map((row) {
      final links = row['memory_context_links'] as List<dynamic>? ?? const [];
      final countRow =
          links.isEmpty ? null : links.first as Map<String, dynamic>?;
      return ContextSummary(
        id: row['id'] as String,
        name: row['name'] as String,
        itemCount: countRow?['count'] as int? ?? 0,
        isActive: row['id'] == activeContextId,
      );
    }).toList();
  }

  Future<void> setActiveContext(String contextId) async {
    final userId = _client.auth.currentUser!.id;
    final contextSpace = await _client
        .from('context_spaces')
        .select('id')
        .eq('owner_id', userId)
        .single();
    final contextSpaceId = contextSpace['id'] as String;
    await _client.from('active_context_preferences').upsert({
      'context_space_id': contextSpaceId,
      'user_id': userId,
      'default_context_id': contextId,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
    }, onConflict: 'context_space_id,user_id');
  }
}
