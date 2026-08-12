import 'package:supabase_flutter/supabase_flutter.dart';

class ContextSummary {
  const ContextSummary({required this.name, required this.itemCount});

  final String name;
  final int itemCount;
}

class ContextSummaryRepository {
  ContextSummaryRepository({SupabaseClient? client})
      : _client = client ?? Supabase.instance.client;

  final SupabaseClient _client;

  Future<List<ContextSummary>> fetchSummaries() async {
    final rows = await _client
        .from('contexts')
        .select('name, memory_context_links(count)')
        .order('created_at');

    return rows.map((row) {
      final links = row['memory_context_links'] as List<dynamic>? ?? const [];
      final countRow =
          links.isEmpty ? null : links.first as Map<String, dynamic>?;
      return ContextSummary(
        name: row['name'] as String,
        itemCount: countRow?['count'] as int? ?? 0,
      );
    }).toList();
  }
}
