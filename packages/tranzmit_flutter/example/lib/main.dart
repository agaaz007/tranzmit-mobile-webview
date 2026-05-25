import 'package:flutter/material.dart';
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

const _apiBaseUrl = String.fromEnvironment(
  'TRANZMIT_API_BASE_URL',
  defaultValue: 'https://api-production-2146.up.railway.app',
);
const _publicKey = String.fromEnvironment(
  'TRANZMIT_PUBLIC_KEY',
  defaultValue: 'pk_test_2a8a5f07d4b9fcf1cc77e024',
);
const _demoTrigger = String.fromEnvironment(
  'TRANZMIT_TRIGGER',
  defaultValue: 'upgrade_pro',
);

void main() {
  runApp(
    TranzmitProvider(
      config: const TranzmitConfig(
        publicKey: _publicKey,
        apiBaseUrl: _apiBaseUrl,
        userId: 'flutter-sdk-harness',
      ),
      onError: (error) => debugPrint('[Tranzmit] ${error.code}: ${error.message}'),
      child: const SdkHarnessApp(),
    ),
  );
}

class SdkHarnessApp extends StatelessWidget {
  const SdkHarnessApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6537D9)),
        scaffoldBackgroundColor: const Color(0xFFF7F8FA),
        useMaterial3: true,
      ),
      home: const SdkHarnessScreen(),
    );
  }
}

class SdkHarnessScreen extends StatefulWidget {
  const SdkHarnessScreen({super.key});

  @override
  State<SdkHarnessScreen> createState() => _SdkHarnessScreenState();
}

class _SdkHarnessScreenState extends State<SdkHarnessScreen> {
  TranzmitController? _controller;
  String? _lastError;
  String? _lastEvent;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final next = Tranzmit.of(context);
    if (_controller == next) return;
    _controller?.removeListener(_onControllerChanged);
    _controller = next..addListener(_onControllerChanged);
  }

  @override
  void dispose() {
    _controller?.removeListener(_onControllerChanged);
    super.dispose();
  }

  void _onControllerChanged() {
    if (mounted) setState(() {});
  }

  void _setEvent(String message) {
    setState(() => _lastEvent = message);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), duration: const Duration(seconds: 2)),
    );
  }

  Future<void> _refreshConfig() async {
    final controller = _controller;
    if (controller == null) return;
    try {
      await controller.refreshConfig();
      _setEvent('Config refreshed from server');
    } on TranzmitError catch (error) {
      setState(() => _lastError = '${error.code}: ${error.message}');
      _setEvent('Refresh failed: ${error.code}');
    }
  }

  void _presentPaywall() {
    final controller = _controller;
    if (controller == null) return;

    if (!controller.isReady) {
      _setEvent('SDK not ready yet — wait for init or refresh');
      return;
    }

    final placement = controller.getPlacement(_demoTrigger);
    if (placement == null) {
      _setEvent('No active placement for "$_demoTrigger"');
      return;
    }

    final document = placement.spec.document;
    if (document?.html == null || document!.html!.isEmpty) {
      _setEvent('Hosted document not hydrated yet — tap Refresh config');
      return;
    }

    final result = controller.presentPlacement(
      _demoTrigger,
      onCTA: (product) async {
        _setEvent('CTA tapped: ${product.id} — starting host purchase flow');
        await _simulateHostPurchase(product);
        controller.reportConversion({
          'trigger': _demoTrigger,
          'productId': product.id,
          'revenue': 999,
          'currency': 'INR',
        });
        _setEvent('reportConversion sent for ${product.id}');
      },
      onDismiss: () => _setEvent('Paywall dismissed'),
      onImpression: () => _setEvent('Impression tracked for $_demoTrigger'),
    );

    if (!result.shown) {
      _setEvent('Paywall was not shown');
    }
  }

  Future<void> _simulateHostPurchase(ProductSpec product) async {
    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Host purchase (demo)'),
        content: Text(
          'In a real app this is where you call StoreKit / Play Billing / RevenueCat for:\n\n${product.id}',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Complete purchase'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final controller = _controller;
    final placement = controller?.getPlacement(_demoTrigger);
    final spec = placement?.spec;
    final document = spec?.document;
    final htmlLoaded = document?.html != null && document!.html!.isNotEmpty;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Tranzmit SDK Harness'),
        actions: [
          IconButton(
            tooltip: 'Refresh config',
            onPressed: controller == null ? null : _refreshConfig,
            icon: const Icon(Icons.refresh),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(20),
          children: [
            _StatusCard(
              title: 'SDK status',
              rows: [
                _StatusRow('Ready', controller?.isReady == true ? 'yes' : 'no'),
                const _StatusRow('API', _apiBaseUrl),
                const _StatusRow('Public key', _publicKey),
                const _StatusRow('Trigger', _demoTrigger),
                if (_lastError != null) _StatusRow('Last error', _lastError!),
                if (_lastEvent != null) _StatusRow('Last event', _lastEvent!),
              ],
            ),
            const SizedBox(height: 16),
            _StatusCard(
              title: 'Remote placement',
              rows: [
                _StatusRow(
                  'Placement',
                  placement == null ? 'not loaded' : placement.placementId ?? _demoTrigger,
                ),
                _StatusRow('Variant', placement?.variantId ?? '—'),
                _StatusRow('Renderer', spec?.renderer ?? '—'),
                _StatusRow('Presentation', spec?.presentationMode ?? 'sheet'),
                _StatusRow('Revision', spec?.revision?.toString() ?? '—'),
                _StatusRow('Cache key', spec?.cacheKey ?? '—'),
                _StatusRow('Document URL', document?.url ?? '—'),
                _StatusRow('HTML hydrated', htmlLoaded ? 'yes' : 'no'),
                _StatusRow('Integrity', document?.integrity ?? '—'),
              ],
            ),
            const SizedBox(height: 16),
            const Text(
              'This app contains zero hardcoded paywall UI. Everything comes from Tranzmit config + hosted WebView documents.',
              style: TextStyle(color: Color(0xFF6B7280), height: 1.45),
            ),
            const SizedBox(height: 20),
            FilledButton.icon(
              onPressed: controller?.isReady == true ? _presentPaywall : null,
              icon: const Icon(Icons.lock_open),
              label: const Text('Present "$_demoTrigger"'),
            ),
            const SizedBox(height: 8),
            OutlinedButton.icon(
              onPressed: controller == null ? null : _refreshConfig,
              icon: const Icon(Icons.cloud_download),
              label: const Text('Refresh config from server'),
            ),
          ],
        ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard({required this.title, required this.rows});

  final String title;
  final List<_StatusRow> rows;

  @override
  Widget build(BuildContext context) {
    return Card(
      elevation: 0,
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: const BorderSide(color: Color(0xFFE5E7EB)),
      ),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title,
              style: const TextStyle(
                fontSize: 13,
                fontWeight: FontWeight.w700,
                letterSpacing: 0.5,
                color: Color(0xFF6B7280),
              ),
            ),
            const SizedBox(height: 12),
            for (final row in rows) ...[
              row,
              if (row != rows.last) const SizedBox(height: 8),
            ],
          ],
        ),
      ),
    );
  }
}

class _StatusRow extends StatelessWidget {
  const _StatusRow(this.label, this.value);

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 112,
          child: Text(
            label,
            style: const TextStyle(color: Color(0xFF9CA3AF), fontSize: 13),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(color: Color(0xFF111827), fontSize: 13),
          ),
        ),
      ],
    );
  }
}
