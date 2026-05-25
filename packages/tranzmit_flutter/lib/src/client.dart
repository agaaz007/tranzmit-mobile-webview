import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

import 'models.dart';

const _configKeyPrefix = 'tranzmit:config:';
const _stableIdPrefix = 'tranzmit:stable_id:';
const _fetchTimeout = Duration(seconds: 8);
const _flushDelay = Duration(seconds: 30);
const _maxQueueSize = 100;
const _flushBatchSize = 10;
const _maxAttempts = 3;

class TranzmitError implements Exception {
  TranzmitError(this.code, this.message, {required this.recoverable});

  final String code;
  final String message;
  final bool recoverable;

  @override
  String toString() => 'TranzmitError($code): $message';
}

class PlatformMetadata {
  const PlatformMetadata({
    this.platform,
    this.os,
    this.sdkVersion,
  });

  final String? platform;
  final String? os;
  final String? sdkVersion;
}

abstract class TranzmitStorage {
  Future<String?> get(String key);
  Future<void> set(String key, String value);
  Future<void> remove(String key);
}

class SharedPreferencesTranzmitStorage implements TranzmitStorage {
  SharedPreferencesTranzmitStorage([this._preferences]);

  final SharedPreferences? _preferences;

  static Future<SharedPreferencesTranzmitStorage> create() async {
    return SharedPreferencesTranzmitStorage(
      await SharedPreferences.getInstance(),
    );
  }

  Future<SharedPreferences> get _instance async {
    final preferences = _preferences;
    if (preferences != null) return preferences;
    return SharedPreferences.getInstance();
  }

  @override
  Future<String?> get(String key) async => (await _instance).getString(key);

  @override
  Future<void> set(String key, String value) async {
    await (await _instance).setString(key, value);
  }

  @override
  Future<void> remove(String key) async {
    await (await _instance).remove(key);
  }
}

class MemoryTranzmitStorage implements TranzmitStorage {
  final Map<String, String> _store = <String, String>{};

  @override
  Future<String?> get(String key) async => _store[key];

  @override
  Future<void> set(String key, String value) async {
    _store[key] = value;
  }

  @override
  Future<void> remove(String key) async {
    _store.remove(key);
  }
}

class QueuedEvent {
  QueuedEvent({
    required this.event,
    required this.timestamp,
    this.properties,
    this.attempts = 0,
  });

  final String event;
  final int timestamp;
  final Map<String, Object?>? properties;
  final int attempts;

  QueuedEvent incrementAttempt() => QueuedEvent(
        event: event,
        timestamp: timestamp,
        properties: properties,
        attempts: attempts + 1,
      );

  JsonMap toJson() => {
        'event': event,
        'timestamp': timestamp,
        if (properties != null) 'properties': properties,
      };
}

class TranzmitClient {
  TranzmitClient({
    required TranzmitStorage storage,
    http.Client? httpClient,
    PlatformMetadata metadata = const PlatformMetadata(
      platform: 'flutter',
      sdkVersion: '0.1.0',
    ),
    this.onError,
  })  : _storage = storage,
        _httpClient = httpClient ?? http.Client(),
        _metadata = metadata;

  final TranzmitStorage _storage;
  final http.Client _httpClient;
  final PlatformMetadata _metadata;
  final void Function(TranzmitError error)? onError;

  TranzmitConfig? _currentConfig;
  TranzmitIdentity? _currentIdentity;
  ConfigResponse? _configResponse;
  bool _initialized = false;
  Future<void>? _initFuture;
  String? _currentInitKey;
  String _sessionId = _generateSessionId();
  List<QueuedEvent> _queue = <QueuedEvent>[];
  Timer? _timer;

  bool get isReady => _initialized;
  ConfigResponse? get config => _configResponse;
  String get sessionId => _sessionId;
  TranzmitIdentity? get identity => _currentIdentity;

  Future<void> init(TranzmitConfig config) async {
    validatePublicKey(config.publicKey);

    final identity = await resolveIdentity(
      publicKey: config.publicKey,
      userId: config.userId,
      identifiers: config.identifiers,
      storage: _storage,
    );
    final nextKey = _initKey(config, identity);

    if (_currentInitKey == nextKey && _initFuture != null) {
      await _initFuture!;
      return;
    }
    if (_currentInitKey == nextKey && _initialized) return;

    _clearFlushTimer();
    _queue = <QueuedEvent>[];
    _currentConfig = config;
    _currentIdentity = identity;
    _currentInitKey = nextKey;
    _configResponse = null;
    _initialized = false;
    _sessionId = _generateSessionId();

    _initFuture = _initFromCacheThenNetwork(config, identity);
    await _initFuture!;
  }

  Future<void> refreshConfig() async {
    final config = _currentConfig;
    final identity = _currentIdentity;
    if (config == null || identity == null) return;

    try {
      final fresh = await _fetchConfig(config, identity);
      _configResponse = fresh;
      _initialized = true;
      await _setCachedConfig(config, identity, fresh);
    } catch (error) {
      final tranzmitError = TranzmitError(
        'config_refresh_failed',
        error.toString(),
        recoverable: true,
      );
      onError?.call(tranzmitError);
      throw tranzmitError;
    }
  }

  PlacementConfig? getPlacement(String trigger) {
    final placement = _configResponse?.placements[trigger];
    if (!_initialized || placement == null || !placement.enabled) return null;
    return placement;
  }

  void track(String event, [Map<String, Object?>? properties]) {
    if (_currentConfig == null) return;

    _queue.add(
      QueuedEvent(
        event: event,
        timestamp: DateTime.now().millisecondsSinceEpoch,
        properties: _addMetadata(properties),
      ),
    );

    if (_queue.length > _maxQueueSize) {
      _queue = _queue.sublist(_queue.length - _maxQueueSize);
    }

    if (_queue.length >= _flushBatchSize) {
      unawaited(flush());
    } else {
      _timer ??= Timer(_flushDelay, () => unawaited(flush()));
    }
  }

  void reportConversion(Map<String, Object?> data) {
    final trigger = data['trigger'];
    final placement = trigger is String ? _configResponse?.placements[trigger] : null;
    track(
      'conversion',
      placement == null
          ? data
          : <String, Object?>{
              ...data,
              ...attribution(trigger as String, placement),
            },
    );
    unawaited(flush());
  }

  Future<void> flush() async {
    final config = _currentConfig;
    if (config == null || _queue.isEmpty) return;

    _clearFlushTimer();
    final batch = List<QueuedEvent>.from(_queue);
    _queue.clear();

    try {
      final response = await _httpClient.post(
        Uri.parse('${config.resolvedApiBaseUrl}/v1/events'),
        headers: const {'Content-Type': 'application/json'},
        body: jsonEncode({
          'publicKey': config.publicKey,
          if (config.userId != null) 'userId': config.userId,
          if (_currentIdentity != null) 'identity': _currentIdentity!.toJson(),
          'traits': config.userTraits ?? <String, Object?>{},
          'privateTraits': config.privateTraits ?? <String, Object?>{},
          'sessionId': _sessionId,
          'events': batch.map((event) => event.toJson()).toList(),
        }),
      );

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw TranzmitError(
          'event_flush_failed',
          'Event flush failed: HTTP ${response.statusCode}',
          recoverable: true,
        );
      }
    } catch (_) {
      _requeue(batch);
    }
  }

  void handleBackground() {
    unawaited(flush());
  }

  void handleForeground() {
    _sessionId = _generateSessionId();
  }

  void reset() {
    _clearFlushTimer();
    _currentConfig = null;
    _currentIdentity = null;
    _configResponse = null;
    _initialized = false;
    _initFuture = null;
    _currentInitKey = null;
    _sessionId = _generateSessionId();
    _queue = <QueuedEvent>[];
  }

  Future<void> _initFromCacheThenNetwork(
    TranzmitConfig config,
    TranzmitIdentity identity,
  ) async {
    final cached = await _getCachedConfig(config, identity);
    if (cached != null) {
      _configResponse = cached;
      _initialized = true;
      track('page_view');
      unawaited(_refreshBestEffort(config, identity));
      return;
    }

    try {
      final fresh = await _fetchConfig(config, identity);
      _configResponse = fresh;
      _initialized = true;
      await _setCachedConfig(config, identity, fresh);
      track('page_view');
    } catch (error) {
      final tranzmitError = TranzmitError(
        'config_fetch_failed',
        error.toString(),
        recoverable: true,
      );
      onError?.call(tranzmitError);
      _initFuture = null;
      _currentInitKey = null;
      throw tranzmitError;
    }
  }

  Future<void> _refreshBestEffort(
    TranzmitConfig config,
    TranzmitIdentity identity,
  ) async {
    try {
      final fresh = await _fetchConfig(config, identity);
      _configResponse = fresh;
      await _setCachedConfig(config, identity, fresh);
    } catch (error) {
      onError?.call(
        TranzmitError('config_refresh_failed', error.toString(), recoverable: true),
      );
    }
  }

  Future<ConfigResponse?> _getCachedConfig(
    TranzmitConfig config,
    TranzmitIdentity identity,
  ) async {
    try {
      final raw = await _storage.get(_configStorageKey(config, identity));
      if (raw == null) return null;

      final cached = jsonDecode(raw) as JsonMap;
      final configJson = Map<String, dynamic>.from(cached['config'] as Map);
      final cachedConfig = ConfigResponse.fromJson(configJson);
      // Stale configs are still useful offline. init() always refreshes in the
      // background when cache exists, so TTL controls freshness, not availability.

      return cachedConfig;
    } catch (_) {
      return null;
    }
  }

  Future<void> _setCachedConfig(
    TranzmitConfig config,
    TranzmitIdentity identity,
    ConfigResponse response,
  ) async {
    try {
      await _storage.set(
        _configStorageKey(config, identity),
        jsonEncode({
          'config': response.toJson(),
          'cachedAt': DateTime.now().millisecondsSinceEpoch,
        }),
      );
    } catch (_) {
      // Best-effort cache.
    }
  }

  Future<ConfigResponse> _fetchConfig(
    TranzmitConfig config,
    TranzmitIdentity identity,
  ) async {
    final response = await _httpClient
        .post(
          Uri.parse('${config.resolvedApiBaseUrl}/v1/config'),
          headers: const {'Content-Type': 'application/json'},
          body: jsonEncode({
            'publicKey': config.publicKey,
            'identity': identity.toJson(),
            'traits': config.userTraits ?? <String, Object?>{},
            'privateTraits': config.privateTraits ?? <String, Object?>{},
          }),
        )
        .timeout(_fetchTimeout);

    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw TranzmitError(
        'config_fetch_failed',
        'Config fetch failed: HTTP ${response.statusCode}',
        recoverable: true,
      );
    }

    final json = jsonDecode(response.body) as JsonMap;
    await _hydratePaywallDocuments(json);
    return ConfigResponse.fromJson(json);
  }

  Future<void> _hydratePaywallDocuments(JsonMap configJson) async {
    final rawPlacements = configJson['placements'];
    if (rawPlacements is! Map) return;

    for (final placement in rawPlacements.values) {
      if (placement is! Map) continue;
      final spec = placement['spec'];
      if (spec is! Map) continue;
      final document = spec['document'];
      if (document is! Map) continue;
      if (document['html'] is String) continue;
      final url = document['url'];
      if (url is! String || url.isEmpty) continue;

      final response = await _httpClient.get(Uri.parse(url)).timeout(_fetchTimeout);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw TranzmitError(
          'paywall_document_fetch_failed',
          'Paywall document fetch failed: HTTP ${response.statusCode}',
          recoverable: true,
        );
      }

      final contentType = response.headers['content-type'] ?? '';
      if (contentType.contains('application/json')) {
        final payload = jsonDecode(response.body) as JsonMap;
        final html = payload['html'];
        if (html is! String || html.isEmpty) {
          throw TranzmitError(
            'paywall_document_invalid',
            'Paywall document payload is missing html',
            recoverable: true,
          );
        }
        document['html'] = html;
        if (payload['css'] != null) document['css'] = payload['css'];
        if (payload['js'] != null) document['js'] = payload['js'];
        if (payload['baseUrl'] != null) document['baseUrl'] = payload['baseUrl'];
        if (payload['integrity'] != null) document['integrity'] = payload['integrity'];
      } else {
        document['html'] = response.body;
      }
    }
  }

  Map<String, Object?>? _addMetadata(Map<String, Object?>? properties) {
    final next = <String, Object?>{...?properties};
    if (_metadata.platform != null) next['platform'] = _metadata.platform;
    if (_metadata.os != null) next['os'] = _metadata.os;
    if (_metadata.sdkVersion != null) next['sdk_version'] = _metadata.sdkVersion;
    return next.isEmpty ? null : next;
  }

  void _requeue(List<QueuedEvent> batch) {
    final retryable = batch
        .map((event) => event.incrementAttempt())
        .where((event) => event.attempts <= _maxAttempts);
    final combined = <QueuedEvent>[...retryable, ..._queue];
    _queue = combined.length > _maxQueueSize
        ? combined.sublist(combined.length - _maxQueueSize)
        : combined;
  }

  void _clearFlushTimer() {
    _timer?.cancel();
    _timer = null;
  }
}

Future<TranzmitIdentity> resolveIdentity({
  required String publicKey,
  String? userId,
  Map<String, String>? identifiers,
  TranzmitStorage? storage,
}) async {
  final normalized = <String, String>{};
  identifiers?.forEach((key, value) {
    final trimmedKey = key.trim();
    final trimmedValue = value.trim();
    if (trimmedKey.isNotEmpty && trimmedValue.isNotEmpty) {
      normalized[trimmedKey] = trimmedValue;
    }
  });

  normalized['stableID'] ??= await _getOrCreateStableId(publicKey, storage);

  final trimmedUserId = userId?.trim();
  return TranzmitIdentity(
    userId: trimmedUserId == null || trimmedUserId.isEmpty ? null : trimmedUserId,
    identifiers: normalized,
  );
}

String stableJson(Object? value) {
  if (value is List) {
    return '[${value.map(stableJson).join(',')}]';
  }
  if (value is Map) {
    final keys = value.keys.map((key) => key.toString()).toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${stableJson(value[key])}').join(',')}}';
  }
  return jsonEncode(value);
}

String hashString(String input) {
  var hash = 5381;
  for (final codeUnit in input.codeUnits) {
    hash = (((hash << 5) + hash) ^ codeUnit) & 0xFFFFFFFF;
  }
  return hash.toRadixString(36);
}

void validatePublicKey(String key) {
  if (!RegExp(r'^pk_(live|test)_[A-Za-z0-9_]+$').hasMatch(key)) {
    throw TranzmitError(
      'init_invalid_key',
      'publicKey must match pk_live_xxx or pk_test_xxx',
      recoverable: false,
    );
  }
}

Map<String, Object?> attribution(String trigger, PlacementConfig placement) {
  return <String, Object?>{
    'trigger': trigger,
    'variantId': placement.variantId,
    'variant_key': placement.variantKey ?? placement.variantId,
    if (placement.placementId != null) 'placement_id': placement.placementId,
  };
}

String _configStorageKey(TranzmitConfig config, TranzmitIdentity identity) {
  return '$_configKeyPrefix${config.publicKey}:${_configCacheKey(config, identity)}';
}

String _initKey(TranzmitConfig config, TranzmitIdentity identity) {
  return stableJson({
    'publicKey': config.publicKey,
    'identity': identity.toJson(),
    'apiBaseUrl': config.resolvedApiBaseUrl,
    'userTraits': config.userTraits ?? <String, Object?>{},
    'privateTraits': config.privateTraits ?? <String, Object?>{},
  });
}

String _configCacheKey(TranzmitConfig config, TranzmitIdentity identity) {
  return hashString(
    stableJson({
      'publicKey': config.publicKey,
      'identity': identity.toJson(),
      'userTraits': config.userTraits ?? <String, Object?>{},
      'privateTraits': config.privateTraits ?? <String, Object?>{},
    }),
  );
}

Future<String> _getOrCreateStableId(
  String publicKey,
  TranzmitStorage? storage,
) async {
  final key = _stableIdPrefix + publicKey;
  try {
    final existing = await storage?.get(key);
    if (existing != null && existing.isNotEmpty) return existing;
  } catch (_) {
    // Storage can be unavailable in restricted environments.
  }

  final generated = 'trz_${const Uuid().v4()}';
  try {
    await storage?.set(key, generated);
  } catch (_) {
    // Keep the generated ID in memory for this process if persistence fails.
  }
  return generated;
}

String _generateSessionId() {
  final now = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
  final random = Random().nextInt(0xFFFFFFFF).toRadixString(36).padLeft(8, '0');
  return 'sess_${now}_${random.substring(0, 8)}';
}
