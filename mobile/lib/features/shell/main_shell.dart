import 'dart:async';

import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';
import 'package:wakelock_plus/wakelock_plus.dart';

import '../../core/api/active_context_client.dart';
import '../../core/api/context_sources_client.dart';
import '../../core/api/dialog_processing_client.dart';
import '../../core/data/dialog_session_repository.dart';
import '../../core/realtime/realtime_dialog_controller.dart';
import '../../core/theme/modernist_colors.dart';
import '../context_selection/kontext_tab.dart';
import '../dialog_results/ergebnisse_tab.dart';
import '../dialog_session/session_tab.dart';

// Bumped by hand on every redeploy to the phone so a fresh install is
// visually confirmable on-screen — see the "USB Debugging"/eventLog mixup
// where a hot-reloaded build silently ran stale code. Purely a debugging
// aid, not a real app version.
const _buildVersion = 'v3';

/// App shell: owns the live-dialog session and everything needed across
/// tabs (RealtimeDialogController, context sources, results), and hosts the
/// three persistent tabs — Session, Kontext, Ergebnisse — behind a bottom
/// nav bar. A live WebRTC session must survive tab switches, so all of this
/// state lives here, one level above the tabs, and the tabs themselves are
/// kept mounted via IndexedStack rather than rebuilt on every switch.
class MainShell extends StatefulWidget {
  const MainShell({super.key});

  @override
  State<MainShell> createState() => _MainShellState();
}

class _MainShellState extends State<MainShell> {
  final _controller = RealtimeDialogController();
  final _sessionRepository = DialogSessionRepository();
  final _sourcesClient = ContextSourcesClient();
  final _dialogProcessingClient = DialogProcessingClient();
  StreamSubscription<String>? _dialogStateSubscription;
  StreamSubscription<String>? _liveTranscriptSubscription;
  StreamSubscription<String>? _processingActivitySubscription;
  StreamSubscription<ActiveContext?>? _activeContextSubscription;
  StreamSubscription<RealtimeConnectionState>? _connectionStateSubscription;

  String? _dialogSessionId;
  // Set (not cleared) whenever a session ends — feeds ErgebnisseTab. Stays
  // null until the first session in this app run finishes.
  String? _lastEndedSessionId;
  String? _dialogState;
  String _liveTranscript = '';
  String _processingActivity = '';
  bool _sessionActive = false;
  bool _sessionChanging = false;
  bool _applyingContextUpdate = false;
  ActiveContext? _activeContext;
  int _selectedTabIndex = 0;
  bool _contextTabVisited = false;
  bool _resultsTabVisited = false;

  // Turn-Kontext-Panel state — lives here so both the Session tab's start
  // action and the Kontext tab's toggle list/live-apply action share one
  // source of truth, pre- and mid-session alike.
  List<ContextSource>? _sources;
  int _tokenBudget = 0;
  Map<String, bool>? _enabledSourceIds;
  bool _sourcesLoading = false;
  String? _sourcesError;

  @override
  void initState() {
    super.initState();
    // Eager despite the "only load for the Kontext tab" note below — the
    // Session tab now also shows a compact active-content-group selector
    // (see SessionTab.sources), so it needs this data from the very first
    // frame too, not just once the user opens Kontext.
    unawaited(_loadSources());
    _dialogStateSubscription = _controller.dialogStates.listen((dialogState) {
      if (mounted) setState(() => _dialogState = dialogState);
    });
    _liveTranscriptSubscription = _controller.liveTranscript.listen((text) {
      if (mounted) setState(() => _liveTranscript = text);
    });
    _processingActivitySubscription =
        _controller.processingActivity.listen((activity) {
      if (mounted) setState(() => _processingActivity = activity);
    });
    _activeContextSubscription =
        _controller.activeContexts.listen((activeContext) {
      if (mounted) setState(() => _activeContext = activeContext);
    });
    // Without this, a silently dropped WebRTC connection (ICE failure,
    // backgrounding, a mobile-network hiccup — all common after a minute or
    // two of a live session) leaves the UI showing "listening" forever: the
    // user keeps talking into a dead session with no feedback and no way to
    // tell it apart from the app just not responding. Every function-call
    // send already fails silently once disconnected (see
    // RealtimeDialogController._handleResponseDone's `on StateError` catches
    // around sendEvent), so this is the only place that can actually surface
    // the failure.
    _connectionStateSubscription = _controller.states.listen((state) {
      if (!_sessionActive ||
          (state != RealtimeConnectionState.failed &&
              state != RealtimeConnectionState.idle)) {
        return;
      }
      unawaited(_handleConnectionLost());
    });
  }

  /// Loaded only when the Kontext tab is first opened. Keeping this out of
  /// app startup avoids blocking the Session screen on a source-list request.
  Future<void> _loadSources() async {
    if (_sourcesLoading) return;
    setState(() {
      _sourcesLoading = true;
      _sourcesError = null;
    });
    try {
      final result = await _sourcesClient.fetchSources();
      if (!mounted) return;
      setState(() {
        _sources = result.sources;
        _tokenBudget = result.tokenBudget;
        _enabledSourceIds = {
          for (final source in result.sources) source.id: source.defaultEnabled,
        };
      });
    } catch (error) {
      debugPrint('Kontextquellen konnten nicht geladen werden: $error');
      if (mounted) {
        setState(() {
          _sourcesError =
              'Kontextquellen konnten nicht geladen werden. Bitte erneut versuchen.';
        });
      }
    } finally {
      if (mounted) setState(() => _sourcesLoading = false);
    }
  }

  void _selectTab(int index) {
    setState(() {
      _selectedTabIndex = index;
      if (index == 1) _contextTabVisited = true;
      if (index == 2) _resultsTabVisited = true;
    });
    if (index == 1 && _sources == null && !_sourcesLoading) {
      unawaited(_loadSources());
    }
  }

  /// Mirrors the stop branch of [_toggleSession] (persist transcript +
  /// event log, trigger post-processing) so a connection that dies on its
  /// own (ICE failure, backgrounding, network hiccup) is recorded exactly
  /// like a manual stop — otherwise the session row is left with
  /// `ended_at: null` forever and its event log, the main tool for
  /// diagnosing this exact kind of failure, is never persisted.
  Future<void> _handleConnectionLost() async {
    unawaited(WakelockPlus.disable());
    final transcript = _controller.transcript;
    final eventLog = _controller.eventLog;
    await _controller.endSession();
    final sessionId = _dialogSessionId;
    _dialogSessionId = null;
    if (sessionId != null) {
      try {
        await _sessionRepository.endSession(
          sessionId,
          fullTranscript: transcript,
        );
        unawaited(_triggerProcessing(sessionId));
        unawaited(_logEvents(sessionId, eventLog));
      } catch (error) {
        debugPrint(
          'Persistieren nach Verbindungsverlust fehlgeschlagen für '
          'Session $sessionId: $error',
        );
      }
    }
    if (!mounted) return;
    setState(() {
      _sessionActive = false;
      _sessionChanging = false;
      if (sessionId != null) {
        _lastEndedSessionId = sessionId;
        _selectedTabIndex = 2;
        _resultsTabVisited = true;
      }
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text('Verbindung unterbrochen. Bitte Session neu starten.'),
      ),
    );
  }

  Future<void> _toggleSession() async {
    setState(() => _sessionChanging = true);
    try {
      if (_sessionActive) {
        unawaited(WakelockPlus.disable());
        final transcript = _controller.transcript;
        final eventLog = _controller.eventLog;
        await _controller.endSession();
        final sessionId = _dialogSessionId;
        _dialogSessionId = null;
        if (sessionId != null) {
          await _sessionRepository.endSession(
            sessionId,
            fullTranscript: transcript,
          );
          unawaited(_triggerProcessing(sessionId));
          unawaited(_logEvents(sessionId, eventLog));
          setState(() {
            _lastEndedSessionId = sessionId;
            _selectedTabIndex = 2;
            _resultsTabVisited = true;
          });
        }
      } else {
        // Turn-Kontext-Panel (Kontext tab) already holds the toggle state —
        // no separate picker screen to await anymore.
        final enabledSourceIds = _enabledSourceIds?.entries
            .where((e) => e.value)
            .map((e) => e.key)
            .toList();

        _dialogState = null;
        _liveTranscript = '';
        _processingActivity = '';
        await _controller.startSession(enabledSourceIds: enabledSourceIds);
        // Keeps the screen on for the whole live session — without this,
        // Android's screen timeout dims/locks the screen mid-session,
        // which (per user report) can visibly interrupt or drop the
        // WebRTC connection well before the user is done talking.
        unawaited(WakelockPlus.enable());
        try {
          _dialogSessionId = await _sessionRepository.startSession(
            startedContextId: _controller.activeContext?.id,
          );
          _controller.bindDialogSession(_dialogSessionId!);
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

  /// Fire-and-forget, silent on failure: this is a debugging aid (see
  /// dialog_session_events), not a core feature — a lost event log should
  /// never interrupt or alarm the user the way a lost transcript would.
  Future<void> _logEvents(
    String dialogSessionId,
    List<Map<String, dynamic>> eventLog,
  ) async {
    try {
      await _sessionRepository.logEvents(dialogSessionId, eventLog);
    } catch (error) {
      debugPrint(
        'Event-Protokoll fehlgeschlagen für Session $dialogSessionId: $error',
      );
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

  /// Pushes the current Kontext-tab toggle state to the running session for
  /// the next Redebeitrag — see RealtimeDialogController.updateInstructions.
  Future<void> _applyContextUpdate() async {
    final enabled = _enabledSourceIds;
    if (enabled == null || _applyingContextUpdate) return;
    setState(() => _applyingContextUpdate = true);
    try {
      final enabledIds =
          enabled.entries.where((e) => e.value).map((e) => e.key).toList();
      final instructions = await _sourcesClient.fetchInstructions(enabledIds);
      await _controller.updateInstructions(instructions);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Kontext für den nächsten Redebeitrag aktualisiert.'),
          ),
        );
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content: Text('Kontext-Aktualisierung fehlgeschlagen: $error')),
        );
      }
    } finally {
      if (mounted) setState(() => _applyingContextUpdate = false);
    }
  }

  @override
  void dispose() {
    unawaited(_dialogStateSubscription?.cancel());
    unawaited(_liveTranscriptSubscription?.cancel());
    unawaited(_activeContextSubscription?.cancel());
    unawaited(_processingActivitySubscription?.cancel());
    unawaited(_connectionStateSubscription?.cancel());
    unawaited(WakelockPlus.disable());
    unawaited(_controller.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: ModernistColors.bg,
      appBar: AppBar(
        backgroundColor: ModernistColors.bg,
        foregroundColor: ModernistColors.text,
        elevation: 0,
        scrolledUnderElevation: 0,
        title: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text(
              'KI VOICE CONTEXT ENGINE',
              style: TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.8,
              ),
            ),
            const SizedBox(width: 8),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
              color: ModernistColors.accentTintBg,
              child: const Text(
                _buildVersion,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  color: ModernistColors.accentDark,
                ),
              ),
            ),
          ],
        ),
        bottom: const PreferredSize(
          preferredSize: Size.fromHeight(2),
          child:
              Divider(height: 2, thickness: 2, color: ModernistColors.divider),
        ),
        actions: [
          IconButton(
            icon: const Icon(Icons.logout),
            tooltip: 'Abmelden',
            color: ModernistColors.textMuted,
            onPressed: () => Supabase.instance.client.auth.signOut(),
          ),
        ],
      ),
      body: IndexedStack(
        index: _selectedTabIndex,
        children: [
          SessionTab(
            controller: _controller,
            sessionActive: _sessionActive,
            sessionChanging: _sessionChanging,
            liveTranscript: _liveTranscript,
            processingActivity: _processingActivity,
            activeContext: _activeContext,
            dialogState: _dialogState,
            onToggleSession: _toggleSession,
            sources: _sources,
            enabledSourceIds: _enabledSourceIds,
            onToggleSource: (id) => setState(
              () => _enabledSourceIds![id] = !(_enabledSourceIds![id] ?? false),
            ),
          ),
          if (_contextTabVisited)
            KontextTab(
              sources: _sources,
              enabled: _enabledSourceIds,
              tokenBudget: _tokenBudget,
              sessionActive: _sessionActive,
              applyingUpdate: _applyingContextUpdate,
              loading: _sourcesLoading,
              loadError: _sourcesError,
              onRetry: _loadSources,
              onToggle: (id) => setState(
                () =>
                    _enabledSourceIds![id] = !(_enabledSourceIds![id] ?? false),
              ),
              onReset: () => setState(() {
                for (final source in _sources ?? const <ContextSource>[]) {
                  _enabledSourceIds![source.id] = source.defaultEnabled;
                }
              }),
              onApply: _applyContextUpdate,
            )
          else
            const SizedBox.shrink(),
          if (_resultsTabVisited)
            ErgebnisseTab(
              key: ValueKey(_lastEndedSessionId),
              dialogSessionId: _lastEndedSessionId,
            )
          else
            const SizedBox.shrink(),
        ],
      ),
      bottomNavigationBar: Container(
        decoration: const BoxDecoration(
          border: Border(
            top: BorderSide(color: ModernistColors.divider, width: 2),
          ),
        ),
        child: BottomNavigationBar(
          currentIndex: _selectedTabIndex,
          onTap: _selectTab,
          type: BottomNavigationBarType.fixed,
          elevation: 0,
          backgroundColor: ModernistColors.bg,
          selectedItemColor: ModernistColors.accent,
          unselectedItemColor: ModernistColors.textMuted,
          selectedLabelStyle: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.6,
          ),
          unselectedLabelStyle: const TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 0.6,
          ),
          items: const [
            BottomNavigationBarItem(icon: Icon(Icons.mic), label: 'SESSION'),
            BottomNavigationBarItem(icon: Icon(Icons.tune), label: 'KONTEXT'),
            BottomNavigationBarItem(
                icon: Icon(Icons.checklist), label: 'ERGEBNISSE'),
          ],
        ),
      ),
    );
  }
}
