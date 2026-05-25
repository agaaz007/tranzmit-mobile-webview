import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

import 'package:tranzmit_flutter_example/main.dart';

void main() {
  testWidgets('example app renders with the Tranzmit provider', (tester) async {
    final client = TranzmitClient(
      storage: MemoryTranzmitStorage(),
      httpClient: _ConfigHttpClient(),
    );

    await tester.pumpWidget(
      TranzmitProvider(
        config: const TranzmitConfig(
          publicKey: 'pk_test_demo',
          apiBaseUrl: 'https://example.test',
        ),
        client: client,
        child: const SdkHarnessApp(),
      ),
    );

    await tester.pump();
    await tester.pumpAndSettle();

    expect(find.text('Tranzmit SDK Harness'), findsOneWidget);
    expect(find.textContaining('upgrade_pro'), findsWidgets);
    await client.flush();
  });
}

class _ConfigHttpClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final body = request.url.path.endsWith('/v1/config')
        ? jsonEncode({
            'version': '1.0.0',
            'placements': <String, Object?>{},
            'assets': <String, Object?>{},
            'ttl': 300,
          })
        : '{}';

    return http.StreamedResponse(
      Stream<List<int>>.value(utf8.encode(body)),
      200,
      headers: {'Content-Type': 'application/json'},
    );
  }
}
