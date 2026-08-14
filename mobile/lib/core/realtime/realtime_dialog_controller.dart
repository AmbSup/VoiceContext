import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

import '../api/active_context_client.dart';
import '../api/ephemeral_token_client.dart';
import '../api/retrieval_client.dart';

enum RealtimeConnectionState {
  idle,
  connecting,
  connected,
  disconnecting,
  failed,
}

class RealtimeDialogException implements Exception {
  RealtimeDialogException(this.message);

  final String message;

  @override
  String toString() => message;
}

// retrieve_memory (state "antworten") takes a few seconds — a real backend
// round trip, not just model thinking time (see api/retrieve/route.ts).
// Confirmed empirically (scripted WebSocket session against the live
// Realtime API) that the model never bundles spoken content with a
// function_call in the same response, however the prompt is worded — so
// asking it nicely in the base instructions to "say something while you
// search" silently does nothing. Forcing a dedicated response turn with
// tool_choice: "none" is what actually works: the model is then unable to
// call a function and says a short natural filler instead.
const _fillerInstructions =
    'Sag jetzt ausschließlich einen einzigen kurzen, natürlichen Satz wie '
    '"Einen Moment bitte" oder "Lass mich kurz nachsehen" — keine weiteren '
    'Informationen, keine Funktionsaufrufe, nichts anderes.';
const _continueAfterFillerInstructions =
    'Rufe jetzt die passende Funktion auf (retrieve_memory für thematische '
    'Suche, list_context_items falls ein konkreter Kontext-Name genannt '
    'wurde, search_web für ausschließlich aktuelle oder allgemeine externe '
    'Informationen, search_context_and_web wenn persönlicher Context mit '
    'aktuellen oder externen Informationen verglichen oder verbunden werden soll, '
    'propose_active_context_switch wenn ausdrücklich ein dauerhafter '
    'Standardkontext-Wechsel gewünscht wurde, confirm_active_context_switch '
    'bei einer eindeutigen Bestätigung des offenen Vorschlags), '
    'um die vorhin gestellte Frage zu beantworten.';
const _offerHelpInstructions =
    'Sag jetzt ausschlieÃŸlich: "Wie kann ich dir helfen?" Keine '
    'Funktionsaufrufe und nichts anderes.';
const _listeningTurnsBeforeHelpOffer = 3;

// Event types that carry raw audio bytes (base64) rather than just
// metadata/text — excluded from [RealtimeDialogController.eventLog]. Text
// events (transcripts, function calls, response.done's token usage, VAD
// timing) are kept; this is the only filter needed to keep that log
// audio-free, see supabase/migrations/0012_dialog_session_events.sql.
const _rawAudioEventTypes = {
  'response.output_audio.delta',
  'response.audio.delta', // older API naming, excluded defensively too
};

/// Owns one Dialog-Session's WebRTC connection to the OpenAI Realtime API.
///
/// The app sends microphone audio directly to OpenAI. The backend is involved
/// only long enough to mint a short-lived client secret; the OpenAI master key
/// is never available to this client.
class RealtimeDialogController {
  RealtimeDialogController({
    EphemeralTokenClient? tokenClient,
    ActiveContextClient? activeContextClient,
    RetrievalClient? retrievalClient,
    http.Client? httpClient,
    Uri? realtimeEndpoint,
  })  : _tokenClient = tokenClient ?? EphemeralTokenClient(),
        _activeContextClient = activeContextClient ?? ActiveContextClient(),
        _retrievalClient = retrievalClient ?? RetrievalClient(),
        _httpClient = httpClient ?? http.Client(),
        _ownsHttpClient = httpClient == null,
        _realtimeEndpointOverride = realtimeEndpoint;

  final EphemeralTokenClient _tokenClient;
  final ActiveContextClient _activeContextClient;
  final RetrievalClient _retrievalClient;
  final http.Client _httpClient;
  final bool _ownsHttpClient;
  final Uri? _realtimeEndpointOverride;

  final _eventController = StreamController<Map<String, dynamic>>.broadcast();
  final _stateController =
      StreamController<RealtimeConnectionState>.broadcast();
  final _dialogStateController = StreamController<String>.broadcast();
  final _audioLevelController = StreamController<double>.broadcast();
  final _liveTranscriptController = StreamController<String>.broadcast();
  final _thinkingController = StreamController<bool>.broadcast();
  final _activeContextController = StreamController<ActiveContext?>.broadcast();

  RTCPeerConnection? _peerConnection;
  RTCDataChannel? _dataChannel;
  MediaStream? _localStream;
  MediaStream? _remoteStream;
  Completer<void>? _dataChannelOpened;
  Timer? _audioLevelTimer;
  RealtimeConnectionState _state = RealtimeConnectionState.idle;
  bool _disposed = false;
  bool _awaitingFillerTurn = false;
  bool _isThinking = false;
  int _consecutiveListeningTurns = 0;
  ActiveContext? _activeContext;
  ActiveContext? _pendingActiveContext;
  bool _pendingActiveContextHasUserReply = false;
  final _transcriptBuffer = StringBuffer();
  String? _liveTranscriptItemId;
  final _liveTranscriptBuffer = StringBuffer();
  final _eventLog = <Map<String, dynamic>>[];

  Stream<Map<String, dynamic>> get events => _eventController.stream;
  Stream<RealtimeConnectionState> get states => _stateController.stream;

  /// Emits "zuhoeren" / "antworten" / "nachfragen" whenever the model calls
  /// the set_dialog_state function tool (see CONTEXT.md "Dialogzustand" and
  /// the `tools` config in web/src/app/api/realtime-token/route.ts).
  Stream<String> get dialogStates => _dialogStateController.stream;

  /// Local microphone input level (0.0-1.0), sampled every 100ms from the
  /// WebRTC `media-source` stats report while a session is connected — real
  /// mic amplitude, not a decorative animation, so the UI can show the user
  /// their voice is actually being picked up in real time.
  Stream<double> get audioLevels => _audioLevelController.stream;

  /// True while the user's completed turn is being processed and until the
  /// assistant starts producing audio (or decides that no reply is needed).
  Stream<bool> get thinking => _thinkingController.stream;
  Stream<ActiveContext?> get activeContexts => _activeContextController.stream;
  ActiveContext? get activeContext => _activeContext;

  /// Live-building text of the user's current/most recent utterance, driven
  /// by `conversation.item.input_audio_transcription.delta` events (word by
  /// word, not just after the user stops talking like `.completed` below) —
  /// NOT yet verified against a live session that delta events actually
  /// arrive for the configured transcription model; falls back cleanly to
  /// only updating on `.completed` if they don't. Resets implicitly on the
  /// first delta of a new utterance — in between, the display simply keeps
  /// showing the last completed line rather than flashing empty.
  Stream<String> get liveTranscript => _liveTranscriptController.stream;
  RealtimeConnectionState get state => _state;
  bool get isConnected => _state == RealtimeConnectionState.connected;

  /// Accumulated "Sprecher: Text" lines for the current/last session, built
  /// from `conversation.item.input_audio_transcription.completed` (user)
  /// and `response.output_audio_transcript.done` (assistant) events — see
  /// https://developers.openai.com/api/docs/guides/realtime-conversations.
  /// Feeds dialog_sessions.full_transcript for the (future) Segmentation
  /// Engine, see docs/implementation-plan.md Phase 2.
  String get transcript => _transcriptBuffer.toString();

  /// Every event received this session, minus raw-audio-bearing ones (see
  /// [_rawAudioEventTypes]) — text/JSON only. Feeds
  /// dialog_session_events for debugging live-dialog issues (VAD-triggered
  /// interruptions, token usage over a session), never sent anywhere until
  /// the caller explicitly persists it after the session ends.
  List<Map<String, dynamic>> get eventLog => List.unmodifiable(_eventLog);

  Future<void> startSession() async {
    _ensureNotDisposed();
    if (_state != RealtimeConnectionState.idle) {
      throw StateError('A Realtime Dialog-Session is already active.');
    }

    _transcriptBuffer.clear();
    _liveTranscriptItemId = null;
    _liveTranscriptBuffer.clear();
    _eventLog.clear();
    _consecutiveListeningTurns = 0;
    _setThinking(false);
    _setState(RealtimeConnectionState.connecting);

    try {
      final realtimeToken = await _tokenClient.fetchEphemeralToken();
      _setActiveContext(realtimeToken.activeContext);
      _pendingActiveContext = null;
      _pendingActiveContextHasUserReply = false;
      if (realtimeToken.expiresAt.isBefore(DateTime.now())) {
        throw RealtimeDialogException(
          'The Realtime client secret expired before the connection started.',
        );
      }

      final peerConnection = await createPeerConnection(
        <String, dynamic>{'sdpSemantics': 'unified-plan'},
      );
      _peerConnection = peerConnection;
      _configurePeerConnectionCallbacks(peerConnection);

      final localStream = await navigator.mediaDevices.getUserMedia(
        <String, dynamic>{
          'audio': <String, dynamic>{
            'echoCancellation': true,
            'noiseSuppression': true,
            'autoGainControl': true,
          },
          'video': false,
        },
      );
      _localStream = localStream;
      for (final track in localStream.getAudioTracks()) {
        await peerConnection.addTrack(track, localStream);
      }

      final dataChannel = await peerConnection.createDataChannel(
        'oai-events',
        RTCDataChannelInit(),
      );
      _dataChannel = dataChannel;
      _dataChannelOpened = Completer<void>();
      _configureDataChannelCallbacks(dataChannel);

      final offer = await peerConnection.createOffer(<String, dynamic>{
        'offerToReceiveAudio': true,
        'offerToReceiveVideo': false,
      });
      await peerConnection.setLocalDescription(offer);

      final response = await _httpClient.post(
        _realtimeEndpointOverride ??
            realtimeToken.realtimeEndpoint ??
            Uri.parse('https://api.openai.com/v1/realtime/calls'),
        headers: <String, String>{
          'Authorization': 'Bearer ${realtimeToken.token}',
          'Content-Type': 'application/sdp',
        },
        body: offer.sdp,
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw RealtimeDialogException(
          'OpenAI rejected the WebRTC offer (${response.statusCode}): '
          '${response.body}',
        );
      }

      await peerConnection.setRemoteDescription(
        RTCSessionDescription(response.body, 'answer'),
      );

      await _dataChannelOpened!.future.timeout(
        const Duration(seconds: 20),
        onTimeout: () => throw RealtimeDialogException(
          'The Realtime event channel did not open in time.',
        ),
      );
      _setState(RealtimeConnectionState.connected);
      await _sendGreeting();
      _audioLevelTimer = Timer.periodic(
        const Duration(milliseconds: 100),
        (_) => unawaited(_pollAudioLevel()),
      );
    } catch (_) {
      _setState(RealtimeConnectionState.failed);
      await _closeRealtimeResources();
      _setState(RealtimeConnectionState.idle);
      rethrow;
    }
  }

  Future<void> _sendGreeting() async {
    final hour = DateTime.now().hour;
    final greeting = hour < 11
        ? 'Guten Morgen'
        : hour < 18
            ? 'Guten Tag'
            : 'Guten Abend';

    await sendEvent({
      'type': 'response.create',
      'response': {
        'input': <dynamic>[],
        'instructions':
            'Sag jetzt ausschlieÃŸlich: "$greeting. Was steht heute an?" '
                'Keine Funktionsaufrufe und nichts anderes.',
        'tool_choice': 'none',
      },
    });
  }

  /// Sends a documented Realtime client event over the `oai-events` channel.
  Future<void> sendEvent(Map<String, dynamic> event) async {
    _ensureNotDisposed();
    final dataChannel = _dataChannel;
    if (_state != RealtimeConnectionState.connected ||
        dataChannel == null ||
        dataChannel.state != RTCDataChannelState.RTCDataChannelOpen) {
      throw StateError('The Realtime Dialog-Session is not connected.');
    }

    await dataChannel.send(RTCDataChannelMessage(jsonEncode(event)));
  }

  Future<void> endSession() async {
    if (_disposed || _state == RealtimeConnectionState.idle) {
      return;
    }

    _setState(RealtimeConnectionState.disconnecting);
    await _closeRealtimeResources();
    _setState(RealtimeConnectionState.idle);
  }

  Future<void> dispose() async {
    if (_disposed) {
      return;
    }
    await endSession();
    _disposed = true;
    if (_ownsHttpClient) {
      _httpClient.close();
    }
    await _eventController.close();
    await _stateController.close();
    await _dialogStateController.close();
    await _audioLevelController.close();
    await _liveTranscriptController.close();
    await _thinkingController.close();
    await _activeContextController.close();
  }

  void _configurePeerConnectionCallbacks(RTCPeerConnection peerConnection) {
    peerConnection.onTrack = (event) {
      if (event.track.kind == 'audio' && event.streams.isNotEmpty) {
        _remoteStream = event.streams.first;
      }
    };
    peerConnection.onConnectionState = (connectionState) {
      if (connectionState ==
              RTCPeerConnectionState.RTCPeerConnectionStateFailed ||
          connectionState ==
              RTCPeerConnectionState.RTCPeerConnectionStateDisconnected) {
        _setState(RealtimeConnectionState.failed);
      }
    };
  }

  void _configureDataChannelCallbacks(RTCDataChannel dataChannel) {
    dataChannel.onDataChannelState = (channelState) {
      if (channelState == RTCDataChannelState.RTCDataChannelOpen &&
          !(_dataChannelOpened?.isCompleted ?? true)) {
        _dataChannelOpened!.complete();
      }
    };
    dataChannel.onMessage = (message) {
      if (message.isBinary || _eventController.isClosed) {
        return;
      }
      try {
        final decoded = jsonDecode(message.text);
        if (decoded is Map<String, dynamic>) {
          _recordEvent(decoded);
          _recordTranscript(decoded);
          _handleLiveUserTranscript(decoded);
          _handleThinkingState(decoded);
          _eventController.add(decoded);
          if (decoded['type'] == 'response.done') {
            unawaited(_handleResponseDone(decoded));
          }
        }
      } on FormatException catch (error, stackTrace) {
        _eventController.addError(error, stackTrace);
      }
    };
  }

  void _handleThinkingState(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'input_audio_buffer.speech_stopped':
        _setThinking(true);
      case 'response.output_audio.delta':
      case 'response.audio.delta':
      case 'error':
        _setThinking(false);
    }
  }

  /// Polls the local mic's `media-source` WebRTC stat for its real-time
  /// audioLevel (0.0-1.0) — see webrtc_interface's StatsReport: `type` and
  /// `values` are a direct passthrough of the native RTCStatsReport, so the
  /// member name matches the W3C WebRTC stats spec exactly.
  int _statsDebugCount = 0;

  Future<void> _pollAudioLevel() async {
    final peerConnection = _peerConnection;
    if (peerConnection == null || _audioLevelController.isClosed) return;
    try {
      final reports = await peerConnection.getStats();
      if (_statsDebugCount < 5) {
        _statsDebugCount++;
        for (final r in reports) {
          debugPrint('[audiolevel-debug] type=${r.type} values=${r.values}');
        }
      }
      for (final report in reports) {
        if (report.type == 'media-source' && report.values['kind'] == 'audio') {
          final level = (report.values['audioLevel'] as num?)?.toDouble();
          if (level != null && !_audioLevelController.isClosed) {
            _audioLevelController.add(level.clamp(0.0, 1.0));
          }
          return;
        }
      }
    } catch (_) {
      // getStats can transiently fail right as the connection is closing —
      // not worth surfacing, the next poll (or session end) supersedes it.
    }
  }

  // Wall-clock time when THIS client received the event is the only timing
  // signal available for later latency analysis — most Realtime API event
  // types carry no timestamp of their own, and the DB row's created_at
  // reflects the bulk insert at session end, not when the event actually
  // happened (see DialogSessionRepository.logEvents).
  void _recordEvent(Map<String, dynamic> event) {
    final type = event['type'];
    if (_rawAudioEventTypes.contains(type)) return;
    _eventLog.add({
      'received_at': DateTime.now().toUtc().toIso8601String(),
      'type': type,
      'event': event,
    });
  }

  void _recordTranscript(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'conversation.item.input_audio_transcription.completed':
        _transcriptBuffer.writeln('User: ${event['transcript']}');
      case 'response.output_audio_transcript.done':
        _transcriptBuffer.writeln('Assistant: ${event['transcript']}');
    }
  }

  /// Feeds [liveTranscript] — separate from _recordTranscript above, which
  /// only cares about the final per-turn text for the persisted session
  /// transcript, not the incremental word-by-word view.
  void _handleLiveUserTranscript(Map<String, dynamic> event) {
    final itemId = event['item_id'] as String?;
    if (itemId == null || _liveTranscriptController.isClosed) return;

    switch (event['type']) {
      case 'conversation.item.input_audio_transcription.delta':
        if (itemId != _liveTranscriptItemId) {
          _liveTranscriptItemId = itemId;
          _liveTranscriptBuffer.clear();
        }
        _liveTranscriptBuffer.write(event['delta'] as String? ?? '');
        _liveTranscriptController.add(_liveTranscriptBuffer.toString());
      case 'conversation.item.input_audio_transcription.completed':
        final finalText = event['transcript'] as String?;
        if (finalText != null) {
          if (_pendingActiveContext != null) {
            _pendingActiveContextHasUserReply = true;
          }
          _liveTranscriptItemId = itemId;
          _liveTranscriptController.add(finalText);
        }
    }
  }

  /// Dispatches function calls the model made in a just-finished response
  /// (see the `tools` config in web/src/app/api/realtime-token/route.ts).
  /// `response.done` already carries each function_call item's complete
  /// `arguments` string, so there's no need to accumulate
  /// response.function_call_arguments.delta events separately.
  ///
  /// A function_call is its own response turn — the Realtime API never
  /// bundles spoken/text content alongside a function_call in the same
  /// response, confirmed empirically (a response containing only a
  /// set_dialog_state call produces no audio at all, regardless of state).
  /// So a follow-up response.create is required whenever the model still
  /// needs to actually say something afterwards: after retrieve_memory (to
  /// speak the grounded answer), after set_dialog_state with state
  /// "nachfragen" (to voice the clarifying question), and after
  /// set_dialog_state with state "antworten" — except that last one is
  /// routed through a forced filler-only turn first (see
  /// _fillerInstructions and the `_awaitingFillerTurn` branch below) rather
  /// than going straight to retrieve_memory, so the user hears something
  /// almost immediately instead of a few silent seconds while the search
  /// runs. "zuhoeren" normally skips the follow-up. After several
  /// consecutive listening-only turns, the client deliberately adds one
  /// brief help offer so a longer session does not feel abandoned.
  Future<void> _handleResponseDone(Map<String, dynamic> event) async {
    final response = event['response'];
    if (response is! Map<String, dynamic>) return;
    final outputItems = response['output'];
    if (outputItems is! List) return;

    final functionCalls = outputItems
        .whereType<Map<String, dynamic>>()
        .where((item) => item['type'] == 'function_call')
        .toList();

    if (_awaitingFillerTurn) {
      _awaitingFillerTurn = false;
      // The forced filler-only turn (tool_choice: "none", see below) just
      // finished. That constraint means it should never contain a
      // function_call — if it doesn't, nudge the model to actually continue
      // with the search it deferred; if it somehow does anyway, fall
      // through to the normal handling below instead of dropping it.
      if (functionCalls.isEmpty) {
        _setThinking(true);
        try {
          await sendEvent({
            'type': 'response.create',
            'response': {'instructions': _continueAfterFillerInstructions},
          });
        } on StateError {
          // Session ended while the filler was being spoken.
        }
        return;
      }
    }

    if (functionCalls.isEmpty) {
      if (_pendingActiveContextHasUserReply) {
        _pendingActiveContext = null;
        _pendingActiveContextHasUserReply = false;
      }
      _setThinking(false);
      return;
    }

    var needsFollowUpResponse = false;
    Map<String, dynamic>? followUpResponseOverrides;

    for (final call in functionCalls) {
      final name = call['name'] as String? ?? '';
      final callId = call['call_id'] as String?;
      if (callId == null) continue;

      final String outputPayload;
      switch (name) {
        case 'set_dialog_state':
          final dialogState = _handleSetDialogState(call);
          outputPayload = jsonEncode({'ok': true});
          if (dialogState == 'antworten') {
            _consecutiveListeningTurns = 0;
            // Force a dedicated filler-only turn next rather than a plain
            // follow-up — see the constants above for why.
            needsFollowUpResponse = true;
            _awaitingFillerTurn = true;
            followUpResponseOverrides = {
              'instructions': _fillerInstructions,
              'tool_choice': 'none',
            };
          } else if (dialogState == 'nachfragen') {
            _consecutiveListeningTurns = 0;
            needsFollowUpResponse = true;
          } else if (dialogState == 'zuhoeren') {
            _consecutiveListeningTurns++;
            if (_consecutiveListeningTurns >= _listeningTurnsBeforeHelpOffer) {
              _consecutiveListeningTurns = 0;
              needsFollowUpResponse = true;
              followUpResponseOverrides = {
                'instructions': _offerHelpInstructions,
                'tool_choice': 'none',
              };
            } else {
              _setThinking(false);
            }
          }
        case 'retrieve_memory':
          outputPayload = await _handleRetrieveMemory(call);
          needsFollowUpResponse = true;
        case 'list_context_items':
          outputPayload = await _handleListContextItems(call);
          needsFollowUpResponse = true;
        case 'search_web':
          outputPayload = await _handleWebSearch(call);
          needsFollowUpResponse = true;
        case 'search_context_and_web':
          outputPayload = await _handleContextAndWebSearch(call);
          needsFollowUpResponse = true;
        case 'propose_active_context_switch':
          outputPayload = await _handleProposeActiveContext(call);
          needsFollowUpResponse = true;
        case 'confirm_active_context_switch':
          outputPayload = await _handleConfirmActiveContext();
          needsFollowUpResponse = true;
        case 'cancel_active_context_switch':
          _pendingActiveContext = null;
          _pendingActiveContextHasUserReply = false;
          outputPayload = jsonEncode({'status': 'cancelled'});
          needsFollowUpResponse = true;
        default:
          outputPayload = jsonEncode({'error': 'unknown_function: $name'});
      }

      try {
        await sendEvent({
          'type': 'conversation.item.create',
          'item': {
            'type': 'function_call_output',
            'call_id': callId,
            'output': outputPayload,
          },
        });
      } on StateError {
        // Session ended/disconnected while we were awaiting retrieval —
        // nothing left to answer back to.
        return;
      }
    }

    final handledContextProposal = functionCalls.any((call) {
      final name = call['name'];
      return name == 'propose_active_context_switch' ||
          name == 'confirm_active_context_switch' ||
          name == 'cancel_active_context_switch';
    });
    final continuesAfterStateOrFiller = _awaitingFillerTurn ||
        (needsFollowUpResponse &&
            functionCalls.any((call) => call['name'] == 'set_dialog_state'));
    if (_pendingActiveContextHasUserReply &&
        !handledContextProposal &&
        !continuesAfterStateOrFiller) {
      _pendingActiveContext = null;
      _pendingActiveContextHasUserReply = false;
    }

    if (needsFollowUpResponse) {
      try {
        await sendEvent({
          'type': 'response.create',
          if (followUpResponseOverrides != null)
            'response': followUpResponseOverrides,
        });
      } on StateError {
        // Same as above.
      }
    }
  }

  /// Returns the reported state (not the function_call_output payload,
  /// which is always `{'ok': true}` — see the caller in _handleResponseDone,
  /// which needs the state itself to decide on a follow-up response.create).
  String _handleSetDialogState(Map<String, dynamic> call) {
    final args = _decodeArguments(call['arguments']);
    final dialogState = args['state'] as String? ?? 'unbekannt';
    if (!_dialogStateController.isClosed) {
      _dialogStateController.add(dialogState);
    }
    return dialogState;
  }

  Future<String> _handleRetrieveMemory(Map<String, dynamic> call) async {
    final args = _decodeArguments(call['arguments']);
    final query = args['query'] as String? ?? '';
    if (query.isEmpty) {
      return jsonEncode({'items': <dynamic>[]});
    }
    try {
      final result = await _retrievalClient.retrieve(
        query,
        contextName: args['context_name'] as String?,
        memoryType: args['memory_type'] as String?,
        occurredFrom: args['occurred_from'] as String?,
        occurredTo: args['occurred_to'] as String?,
      );
      // Passed through as-is: on an ambiguous context_name this carries
      // 'ambiguous_context' instead of populated 'items' (see
      // RetrievalClient.retrieve), which the model reacts to per its tool
      // description in api/realtime-token/route.ts.
      return jsonEncode(result);
    } catch (error) {
      return jsonEncode({'error': 'retrieval_failed: $error'});
    }
  }

  Future<String> _handleListContextItems(Map<String, dynamic> call) async {
    final args = _decodeArguments(call['arguments']);
    final contextName = args['context_name'] as String? ?? '';
    if (contextName.isEmpty) {
      return jsonEncode({'found': false});
    }
    try {
      final result = await _retrievalClient.listContextItems(contextName);
      return jsonEncode(result);
    } catch (error) {
      return jsonEncode({'error': 'list_context_items_failed: $error'});
    }
  }

  Future<String> _handleWebSearch(Map<String, dynamic> call) async {
    final args = _decodeArguments(call['arguments']);
    final query = args['query'] as String? ?? '';
    if (query.isEmpty) {
      return jsonEncode({'answer': ''});
    }
    try {
      final answer = await _retrievalClient.searchWeb(query);
      return jsonEncode({'answer': answer});
    } catch (error) {
      return jsonEncode({'error': 'web_search_failed: $error'});
    }
  }

  Future<String> _handleContextAndWebSearch(
    Map<String, dynamic> call,
  ) async {
    final args = _decodeArguments(call['arguments']);
    final query = args['query'] as String? ?? '';
    if (query.isEmpty) {
      return jsonEncode({
        'personal_context': {'items': <dynamic>[]},
        'internet': {'answer': ''},
      });
    }

    List<Map<String, dynamic>> contextItems = const [];
    Object? ambiguousContext;
    Object? contextNotFound;
    Object? retrievalScope;
    String? contextError;
    String webAnswer = '';
    String? webError;

    await Future.wait<void>([
      () async {
        try {
          final result = await _retrievalClient.retrieve(
            query,
            contextName: args['context_name'] as String?,
            memoryType: args['memory_type'] as String?,
            occurredFrom: args['occurred_from'] as String?,
            occurredTo: args['occurred_to'] as String?,
          );
          contextItems =
              (result['items'] as List<dynamic>? ?? const <dynamic>[])
                  .cast<Map<String, dynamic>>();
          ambiguousContext = result['ambiguous_context'];
          contextNotFound = result['context_not_found'];
          retrievalScope = result['retrieval_scope'];
        } catch (error) {
          contextError = 'context_retrieval_failed: $error';
        }
      }(),
      () async {
        try {
          webAnswer = await _retrievalClient.searchWeb(query);
        } catch (error) {
          webError = 'web_search_failed: $error';
        }
      }(),
    ]);

    return jsonEncode({
      'personal_context': {
        'items': contextItems,
        if (ambiguousContext != null) 'ambiguous_context': ambiguousContext,
        if (contextNotFound != null) 'context_not_found': contextNotFound,
        if (retrievalScope != null) 'retrieval_scope': retrievalScope,
        if (contextError != null) 'error': contextError,
      },
      'internet': {
        'answer': webAnswer,
        if (webError != null) 'error': webError,
      },
      'answer_instructions':
          'Beziehe beide Quellen in die Antwort ein. Kennzeichne klar, was '
              'aus dem persönlichen Context und was aus dem Internet stammt, '
              'und leite danach ein gemeinsames Fazit ab. Fehlt eine Quelle, '
              'nenne das ausdrücklich.',
    });
  }

  Map<String, dynamic> _decodeArguments(dynamic raw) {
    if (raw is! String || raw.isEmpty) return const <String, dynamic>{};
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, dynamic>
          ? decoded
          : const <String, dynamic>{};
    } on FormatException {
      return const <String, dynamic>{};
    }
  }

  Future<String> _handleProposeActiveContext(
    Map<String, dynamic> call,
  ) async {
    final args = _decodeArguments(call['arguments']);
    final contextName = args['context_name'] as String? ?? '';
    if (contextName.trim().isEmpty) {
      _pendingActiveContext = null;
      _pendingActiveContextHasUserReply = false;
      return jsonEncode({'status': 'not_found'});
    }
    try {
      final resolution = await _activeContextClient.resolve(contextName);
      final candidate = resolution.context;
      if (resolution.status == 'ambiguous') {
        _pendingActiveContext = null;
        _pendingActiveContextHasUserReply = false;
        return jsonEncode({
          'status': 'ambiguous',
          'candidates': resolution.candidates,
          'instruction': 'Frage, welcher Kontext gemeint ist.',
        });
      }
      if (resolution.status != 'resolved' || candidate == null) {
        _pendingActiveContext = null;
        _pendingActiveContextHasUserReply = false;
        return jsonEncode({'status': 'not_found'});
      }
      if (candidate.id == _activeContext?.id) {
        _pendingActiveContext = null;
        _pendingActiveContextHasUserReply = false;
        return jsonEncode({
          'status': 'already_active',
          'active_context': candidate.name,
        });
      }
      _pendingActiveContext = candidate;
      _pendingActiveContextHasUserReply = false;
      return jsonEncode({
        'status': 'confirmation_required',
        'candidate': candidate.name,
        'instruction': 'Frage jetzt kurz: Soll ${candidate.name} dein neuer '
            'Standardkontext werden?',
      });
    } catch (error) {
      return jsonEncode({'error': 'context_resolution_failed: $error'});
    }
  }

  Future<String> _handleConfirmActiveContext() async {
    final pending = _pendingActiveContext;
    if (pending == null) {
      return jsonEncode({
        'status': 'no_pending_proposal',
        'instruction': 'Es wurde kein Kontextwechsel gespeichert.',
      });
    }
    try {
      final confirmed = await _activeContextClient.confirm(pending.id);
      _pendingActiveContext = null;
      _pendingActiveContextHasUserReply = false;
      _setActiveContext(confirmed);
      return jsonEncode({
        'status': 'confirmed',
        'active_context': confirmed.name,
      });
    } catch (error) {
      return jsonEncode({'error': 'context_confirmation_failed: $error'});
    }
  }

  Future<void> _closeRealtimeResources() async {
    final dataChannel = _dataChannel;
    final localStream = _localStream;
    final remoteStream = _remoteStream;
    final peerConnection = _peerConnection;

    _audioLevelTimer?.cancel();
    _audioLevelTimer = null;
    _awaitingFillerTurn = false;
    _setThinking(false);
    _dataChannel = null;
    _localStream = null;
    _remoteStream = null;
    _peerConnection = null;
    _dataChannelOpened = null;

    await dataChannel?.close();
    for (final track in localStream?.getTracks() ?? <MediaStreamTrack>[]) {
      await track.stop();
    }
    await localStream?.dispose();
    await remoteStream?.dispose();
    await peerConnection?.close();
    await peerConnection?.dispose();
  }

  void _setState(RealtimeConnectionState value) {
    _state = value;
    if (!_stateController.isClosed) {
      _stateController.add(value);
    }
  }

  void _setThinking(bool value) {
    if (_isThinking == value) return;
    _isThinking = value;
    if (!_thinkingController.isClosed) {
      _thinkingController.add(value);
    }
  }

  void _setActiveContext(ActiveContext? value) {
    _activeContext = value;
    if (!_activeContextController.isClosed) {
      _activeContextController.add(value);
    }
  }

  void _ensureNotDisposed() {
    if (_disposed) {
      throw StateError('RealtimeDialogController has already been disposed.');
    }
  }
}
