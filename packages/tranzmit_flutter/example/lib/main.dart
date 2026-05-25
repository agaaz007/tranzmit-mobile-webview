import 'package:flutter/material.dart';
import 'package:tranzmit_flutter/tranzmit_flutter.dart';

void main() {
  runApp(
    TranzmitProvider(
      config: const TranzmitConfig(
        publicKey: 'pk_test_2a8a5f07d4b9fcf1cc77e024',
        apiBaseUrl: 'https://api-production-2752.up.railway.app',
      ),
      onError: (error) => debugPrint('[Tranzmit] $error'),
      child: const ExampleApp(),
    ),
  );
}

class ExampleApp extends StatelessWidget {
  const ExampleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2563EB)),
        scaffoldBackgroundColor: const Color(0xFFF7F8FA),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  TranzmitController? _controller;
  bool _openedOnInit = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final nextController = Tranzmit.of(context);
    if (_controller == nextController) return;

    _controller?.removeListener(_openWhenReady);
    _controller = nextController..addListener(_openWhenReady);
    _openWhenReady();
  }

  @override
  void dispose() {
    _controller?.removeListener(_openWhenReady);
    super.dispose();
  }

  void _openWhenReady() {
    final controller = _controller;
    if (controller == null || !controller.isReady || _openedOnInit) return;
    _openedOnInit = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) controller.presentPlacement('upgrade_pro');
    });
  }

  @override
  Widget build(BuildContext context) {
    final tranzmit = Tranzmit.of(context);

    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                decoration: BoxDecoration(
                  color: const Color(0xFFEFF6FF),
                  borderRadius: BorderRadius.circular(999),
                ),
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                child: const Text(
                  'Template',
                  style: TextStyle(
                    color: Color(0xFF2563EB),
                    fontSize: 12,
                    fontWeight: FontWeight.w700,
                    letterSpacing: 0.4,
                  ),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Tranzmit Flutter',
                style: TextStyle(
                  color: Color(0xFF111827),
                  fontSize: 34,
                  fontWeight: FontWeight.w700,
                ),
              ),
              const SizedBox(height: 8),
              const Text(
                'The SDK initializes on launch and can present upgrade_pro.',
                style: TextStyle(
                  color: Color(0xFF6B7280),
                  fontSize: 17,
                  height: 24 / 17,
                ),
              ),
              const SizedBox(height: 24),
              Card(
                elevation: 0,
                color: Colors.white,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(18),
                  side: const BorderSide(color: Color(0xFFE5E7EB)),
                ),
                child: const Padding(
                  padding: EdgeInsets.all(24),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Welcome',
                        style: TextStyle(
                          color: Color(0xFF9CA3AF),
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.6,
                        ),
                      ),
                      SizedBox(height: 8),
                      Text(
                'WebView-powered paywalls',
                        style: TextStyle(
                          color: Color(0xFF111827),
                          fontSize: 22,
                          fontWeight: FontWeight.w700,
                        ),
                      ),
                      SizedBox(height: 8),
                      Text(
                'This example mirrors the server-driven WebView integration.',
                        style: TextStyle(
                          color: Color(0xFF6B7280),
                          fontSize: 16,
                          height: 24 / 16,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 16),
              FilledButton(
                onPressed: () => tranzmit.presentPlacement(
                  'upgrade_pro',
                  presentation: PresentationMode.modal,
                ),
                child: const Text('Upgrade'),
              ),
              const SizedBox(height: 8),
              OutlinedButton(
                onPressed: () => tranzmit.refreshConfig(),
                child: const Text('Refresh config'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
