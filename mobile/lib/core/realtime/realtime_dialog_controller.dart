import 'dart:async';
import 'dart:convert';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:http/http.dart' as http;

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

/// Owns one Dialog-Session's WebRTC connection to the OpenAI Realtime API.
///
/// The app sends microphone audio directly to OpenAI. The backend is involved
/// only long enough to mint a short-lived client secret; the OpenAI master key
/// is never available to this client.
class RealtimeDialogController {
  RealtimeDialogController({
    EphemeralTokenClient? tokenClient,
    RetrievalClient? retrievalClient,
    http.Client? httpClient,
    Uri? realtimeEndpoint,
  })  : _tokenClient = tokenClient ?? EphemeralTokenClient(),
        _retrievalClient = retrievalClient ?? RetrievalClient(),
        _httpClient = httpClient ?? http.Client(),
        _ownsHttpClient = httpClient == null,
        _realtimeEndpointOverride = realtimeEndpoint;

  final EphemeralTokenClient _tokenClient;
  final RetrievalClient _retrievalClient;
  final http.Client _httpClient;
  final bool _ownsHttpClient;
  final Uri? _realtimeEndpointOverride;

  final _eventController = StreamController<Map<String, dynamic>>.broadcast();
  final _stateController =
      StreamController<RealtimeConnectionState>.broadcast();
  final _dialogStateController = StreamController<String>.broadcast();

  RTCPeerConnection? _peerConnection;
  RTCDataChannel? _dataChannel;
  MediaStream? _localStream;
  MediaStream? _remoteStream;
  Completer<void>? _dataChannelOpened;
  RealtimeConnectionState _state = RealtimeConnectionState.idle;
  bool _disposed = false;
  final _transcriptBuffer = StringBuffer();

  Stream<Map<String, dynamic>> get events => _eventController.stream;
  Stream<RealtimeConnectionState> get states => _stateController.stream;

  /// Emits "zuhoeren" / "antworten" / "nachfragen" whenever the model calls
  /// the set_dialog_state function tool (see CONTEXT.md "Dialogzustand" and
  /// the `tools` config in web/src/app/api/realtime-token/route.ts).
  Stream<String> get dialogStates => _dialogStateController.stream;
  RealtimeConnectionState get state => _state;
  bool get isConnected => _state == RealtimeConnectionState.connected;

  /// Accumulated "Sprecher: Text" lines for the current/last session, built
  /// from `conversation.item.input_audio_transcription.completed` (user)
  /// and `response.output_audio_transcript.done` (assistant) events — see
  /// https://developers.openai.com/api/docs/guides/realtime-conversations.
  /// Feeds dialog_sessions.full_transcript for the (future) Segmentation
  /// Engine, see docs/implementation-plan.md Phase 2.
  String get transcript => _transcriptBuffer.toString();

  Future<void> startSession() async {
    _ensureNotDisposed();
    if (_state != RealtimeConnectionState.idle) {
      throw StateError('A Realtime Dialog-Session is already active.');
    }

    _transcriptBuffer.clear();
    _setState(RealtimeConnectionState.connecting);

    try {
      final realtimeToken = await _tokenClient.fetchEphemeralToken();
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
    } catch (_) {
      _setState(RealtimeConnectionState.failed);
      await _closeRealtimeResources();
      _setState(RealtimeConnectionState.idle);
      rethrow;
    }
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
          _recordTranscript(decoded);
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

  void _recordTranscript(Map<String, dynamic> event) {
    switch (event['type']) {
      case 'conversation.item.input_audio_transcription.completed':
        _transcriptBuffer.writeln('User: ${event['transcript']}');
      case 'response.output_audio_transcript.done':
        _transcriptBuffer.writeln('Assistant: ${event['transcript']}');
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
  /// needs to actually say something afterwards: after retrieve_memory
  /// (to speak the grounded answer), and after set_dialog_state with
  /// state "antworten" or "nachfragen" (to move on to retrieve_memory, or
  /// to voice the clarifying question). Only "zuhoeren" skips the
  /// follow-up — CONTEXT.md is explicit that no response is wanted there.
  Future<void> _handleResponseDone(Map<String, dynamic> event) async {
    final response = event['response'];
    if (response is! Map<String, dynamic>) return;
    final outputItems = response['output'];
    if (outputItems is! List) return;

    final functionCalls = outputItems
        .whereType<Map<String, dynamic>>()
        .where((item) => item['type'] == 'function_call')
        .toList();
    if (functionCalls.isEmpty) return;

    var needsFollowUpResponse = false;

    for (final call in functionCalls) {
      final name = call['name'] as String? ?? '';
      final callId = call['call_id'] as String?;
      if (callId == null) continue;

      final String outputPayload;
      switch (name) {
        case 'set_dialog_state':
          final dialogState = _handleSetDialogState(call);
          outputPayload = jsonEncode({'ok': true});
          if (dialogState == 'antworten' || dialogState == 'nachfragen') {
            needsFollowUpResponse = true;
          }
        case 'retrieve_memory':
          outputPayload = await _handleRetrieveMemory(call);
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

    if (needsFollowUpResponse) {
      try {
        await sendEvent({'type': 'response.create'});
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
      final items = await _retrievalClient.retrieve(query);
      return jsonEncode({'items': items});
    } catch (error) {
      return jsonEncode({'error': 'retrieval_failed: $error'});
    }
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

  Future<void> _closeRealtimeResources() async {
    final dataChannel = _dataChannel;
    final localStream = _localStream;
    final remoteStream = _remoteStream;
    final peerConnection = _peerConnection;

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

  void _ensureNotDisposed() {
    if (_disposed) {
      throw StateError('RealtimeDialogController has already been disposed.');
    }
  }
}
