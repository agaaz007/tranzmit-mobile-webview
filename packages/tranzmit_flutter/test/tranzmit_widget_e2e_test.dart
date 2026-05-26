import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:tranzmit_flutter/src/controller.dart';
import 'package:tranzmit_flutter/src/models.dart';
import 'package:tranzmit_flutter/src/widgets/spec_renderer.dart';

const _baseSpec = {
  'renderer': 'webview',
  'templateId': 'test_paywall',
  'revision': 'test-1',
  'cacheKey': 'test_paywall:test-1',
  'header': {
    'title': 'Unlock Pro',
    'subtitle': 'Get unlimited exports',
  },
  'document': {
    'html':
        '<main><h1>Unlock Pro</h1><button data-tranzmit-action="cta" data-product-id="pro_monthly">Start Free Trial</button></main>',
    'css': 'body{font-family:sans-serif}',
  },
  'bridge': {
    'version': 1,
    'allowedActions': ['cta', 'dismiss', 'open_url'],
  },
  'cta': 'Start Free Trial',
  'secondaryCta': 'Maybe later',
  'theme': 'light',
  'features': ['Unlimited exports', 'Priority support'],
  'products': [
    {
      'id': 'pro_monthly',
      'name': 'Pro Monthly',
      'price': {'amount': 999, 'currency': 'USD', 'interval': 'month'},
      'badge': 'Popular',
      'highlighted': true,
    },
    {
      'id': 'pro_yearly',
      'name': 'Pro Yearly',
      'price': {'amount': 9999, 'currency': 'USD', 'interval': 'year'},
    },
  ],
};

void main() {
  test('parses WebView bridge messages', () {
    final message = parseWebViewBridgeMessage(
      jsonEncode({'type': 'cta', 'productId': 'pro_monthly'}),
    );

    expect(message, isNotNull);
    expect(bridgeMessageType(message!), 'cta');
  });

  test('ignores malformed WebView bridge messages', () {
    expect(parseWebViewBridgeMessage('not-json'), isNull);
    expect(parseWebViewBridgeMessage('[1,2,3]'), isNull);
  });

  test('maps WebView CTA message to the matching product', () {
    final spec = PaywallSpec.fromJson(Map<String, dynamic>.from(_baseSpec));
    final product = productForWebViewBridgeMessage(
      spec,
      {'type': 'cta', 'productId': 'pro_monthly'},
    );

    expect(product, isNotNull);
    expect(product!.id, 'pro_monthly');
  });

  test('composes presentation-aware fullscreen documents', () {
    final spec = PaywallSpec.fromJson(Map<String, dynamic>.from(_baseSpec));
    final html = composePaywallDocumentForTest(
      spec,
      presentation: PresentationMode.fullscreen,
      viewport: const PaywallViewport(
        width: 412,
        height: 915,
        safeTop: 24,
        safeBottom: 18,
        safeLeft: 0,
        safeRight: 0,
        pixelRatio: 2.75,
        presentation: PresentationMode.fullscreen,
      ),
    );

    expect(html, contains('tz-presentation-fullscreen'));
    expect(html, contains('data-tranzmit-presentation="fullscreen"'));
    expect(html, contains('--tz-vh: 915.00px'));
    expect(html, contains('--tz-safe-bottom: 18.00px'));
    expect(html, contains('"pixelRatio":2.75'));
    expect(html, contains('border-radius: 0 !important'));
    expect(html, contains('width: var(--tz-vw) !important'));
    expect(html, contains('.tz-presentation-fullscreen .tz-close'));
    expect(html, contains('display: none !important'));
    expect(html, contains('window.TranzmitNativeViewport'));
  });
}
