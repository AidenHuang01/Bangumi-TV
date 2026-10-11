// SPDX-License-Identifier: GPL-3.0-or-later
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview_platform_interface/flutter_inappwebview_platform_interface.dart';
import 'package:hive_ce/hive.dart';
import 'package:kazumi/plugins/plugins.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';
import 'package:kazumi/services/storage/storage.dart';
import 'package:kazumi/services/video_source/video_source_format.dart';
import 'package:kazumi/webview/video/impl/video_webview_apple_impl.dart';
import 'package:path_provider/path_provider.dart';

const upstreamCommit = '4e821e48282d0e8e3753fd6266bb1d15e4dc0f02';
const upstreamVersion = '2.3.8';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  try {
    Hive.init('${(await getApplicationSupportDirectory()).path}/hive');
    await GStorage.init();
    final worker = CoreWorker.fromEnvironment();
    await worker.start();
    runApp(
      CoreStatus(
        message:
            'Kazumi $upstreamVersion core running\n'
            'Search / chapters / native macOS video parser\n'
            'Loopback port ${worker.port} · TV playback stays on the TV',
      ),
    );
  } catch (_) {
    runApp(
      const CoreStatus(
        message: 'Kazumi core could not start. Check the server configuration.',
      ),
    );
    Timer(const Duration(seconds: 2), () => exit(1));
  }
}

class CoreStatus extends StatelessWidget {
  const CoreStatus({super.key, required this.message});
  final String message;
  @override
  Widget build(BuildContext context) => MaterialApp(
    home: Scaffold(
      body: Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Text(message, textAlign: TextAlign.center),
        ),
      ),
    ),
  );
}

class CoreWorker {
  CoreWorker({required this.token, required this.port, required this.plugins});
  factory CoreWorker.fromEnvironment() {
    final env = Platform.environment;
    final token = env['BANGUMI_CORE_TOKEN'] ?? '';
    if (token.length < 32) throw const FormatException('Missing worker token');
    final port = int.parse(env['BANGUMI_CORE_PORT'] ?? '8789');
    if (port < 1024 || port > 65535) {
      throw const FormatException('Invalid port');
    }
    final plugins = <String, Plugin>{};
    for (final rule in jsonDecode(env['BANGUMI_CORE_RULES'] ?? '[]') as List) {
      final map = Map<String, dynamic>.from(rule as Map);
      final id = map['id'] as String;
      if (!RegExp(r'^[A-Za-z0-9_-]{1,64}$').hasMatch(id)) {
        throw const FormatException('Invalid provider');
      }
      plugins[id] = Plugin.fromJson(map);
    }
    if (plugins.isEmpty) throw const FormatException('No rules');
    return CoreWorker(token: token, port: port, plugins: plugins);
  }
  final String token;
  final int port;
  final Map<String, Plugin> plugins;
  bool resolving = false;
  int querying = 0;

  Future<void> start() async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, port);
    server.listen((request) {
      unawaited(handle(request));
    });
  }

  Future<void> handle(HttpRequest request) async {
    void respond(int status, Object value) {
      request.response.statusCode = status;
      request.response.headers.contentType = ContentType.json;
      request.response.headers.set('Cache-Control', 'no-store');
      request.response.write(jsonEncode(value));
    }

    try {
      // Phone/TV never receive this token or access this private API.
      if (request.headers.value('authorization') != 'Bearer $token') {
        respond(401, {'error': 'Unauthorized'});
        return;
      }
      if (request.method == 'GET' && request.uri.path == '/health') {
        respond(200, {
          'engine': 'kazumi',
          'upstreamCommit': upstreamCommit,
          'upstreamVersion': upstreamVersion,
          'parser': 'VideoWebviewAppleImpl',
          'capabilities': ['search', 'chapters', 'resolve'],
          'resolving': resolving,
        });
        return;
      }
      if (request.method != 'POST' ||
          !['/search', '/chapters', '/resolve'].contains(request.uri.path)) {
        respond(404, {'error': 'Unknown operation'});
        return;
      }
      if (request.headers.contentType?.mimeType != 'application/json') {
        respond(415, {'error': 'Use JSON'});
        return;
      }
      final bytes = <int>[];
      await for (final chunk in request.timeout(const Duration(seconds: 5))) {
        bytes.addAll(chunk);
        if (bytes.length > 32768) {
          respond(413, {'error': 'Request too large'});
          return;
        }
      }
      final input = jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
      final plugin = plugins[input['provider']];
      if (plugin == null) {
        respond(400, {'error': 'Unknown provider'});
        return;
      }
      if (request.uri.path == '/resolve') {
        if (resolving) {
          respond(429, {
            'error': 'Kazumi is already resolving a video. Try again shortly.',
          });
          return;
        }
        resolving = true;
        try {
          respond(200, await resolve(plugin, webURL(input['url'], plugin)));
        } finally {
          resolving = false;
        }
      } else {
        if (querying >= 12) {
          respond(429, {'error': 'Kazumi search is busy.'});
          return;
        }
        querying++;
        final cancel = RuleCancelToken();
        final timer = Timer(const Duration(seconds: 18), () => cancel.cancel());
        try {
          if (request.uri.path == '/search') {
            final query = input['query'] as String;
            if (query.trim().isEmpty || query.length > 100) {
              throw const FormatException('Invalid query');
            }
            final trace = await plugin.traceSearch(query, cancelToken: cancel);
            respond(200, {
              'items': trace.response.data
                  .take(80)
                  .map(
                    (item) => {
                      'title': item.name,
                      'source': sourceReference(item.src, plugin),
                    },
                  )
                  .toList(),
            });
          } else {
            final trace = await plugin.traceChapters(
              sourceReference(input['source'], plugin),
              cancelToken: cancel,
            );
            respond(200, {
              'roads': trace.roads
                  .take(20)
                  .map(
                    (road) => {
                      'name': road.name,
                      'episodes': List.generate(
                        road.data.length.clamp(0, 500),
                        (i) => {
                          'name': road.identifier[i],
                          'url': webURL(road.data[i], plugin),
                        },
                      ),
                    },
                  )
                  .toList(),
            });
          }
        } finally {
          timer.cancel();
          querying--;
        }
      }
    } on CaptchaRequiredException {
      respond(502, {
        'error':
            'Source requires manual verification. Choose another provider.',
      });
    } on NoResultException {
      respond(200, {'items': <Object>[]});
    } on TimeoutException {
      respond(504, {
        'error':
            'Kazumi did not find a stream within 45 seconds. Choose another source.',
      });
    } on FormatException {
      respond(400, {'error': 'Invalid core request or source URL.'});
    } catch (_) {
      respond(502, {
        'error':
            'Kazumi source request failed. The provider may be unavailable or its rule outdated.',
      });
    } finally {
      await request.response.close();
    }
  }

  String sourceReference(Object? value, Plugin plugin) {
    // API rules may use opaque numeric/string IDs, not page URLs. Preserve them
    // exactly for the upstream @source request and episode-page templates.
    if (value is! String || value.isEmpty || value.length > 8192) {
      throw const FormatException('Invalid source');
    }
    return plugin.chapterMode == 'api' ? value : webURL(value, plugin);
  }

  String webURL(Object? value, Plugin plugin) {
    if (value is! String || value.length > 8192) {
      throw const FormatException('Invalid URL');
    }
    final uri = Uri.parse(plugin.baseUrl).resolve(value);
    if (!['http', 'https'].contains(uri.scheme) ||
        uri.host.isEmpty ||
        uri.userInfo.isNotEmpty) {
      throw const FormatException('Invalid URL');
    }
    return uri.toString();
  }

  Future<Map<String, Object?>> resolve(Plugin plugin, String episodeURL) async {
    // Fresh per episode: upstream injection mode is sticky. Original WKWebView
    // implementation and both upstream parser scripts run unchanged.
    final parser = VideoWebviewAppleImpl();
    final elapsed = Stopwatch()..start();
    Duration remaining() => Duration(
      milliseconds: (45000 - elapsed.elapsedMilliseconds).clamp(0, 45000),
    );
    final result = Completer<Map<String, Object?>>();
    result.future.ignore(); // An early parser error is still awaited below.
    var lastPage = episodeURL;
    final logs = parser.onLog.listen((message) {
      const prefix = 'started loading: ';
      if (message.startsWith(prefix)) {
        final candidate = message.substring(prefix.length);
        if (candidate.startsWith('https://') ||
            candidate.startsWith('http://')) {
          lastPage = candidate;
        }
      }
    });
    final events = parser.onVideoURLParser.listen((event) async {
      if (result.isCompleted) return;
      try {
        final url = webURL(event.url, plugin);
        final settings = await parser.webviewController?.getSettings();
        final cookies = await PlatformCookieManager(
          const PlatformCookieManagerCreationParams(),
        ).getCookies(url: WebUri(url));
        result.complete({
          'url': url,
          'format':
              event.format == VideoSourceFormat.hls ||
                  RegExp(
                    r'\.m3u8(?:[?#]|$)',
                    caseSensitive: false,
                  ).hasMatch(url)
              ? 'hls'
              : 'mp4',
          'referer': plugin.referer.isNotEmpty ? plugin.referer : lastPage,
          'userAgent': settings?.userAgent,
          'cookie': cookies
              .map((cookie) => '${cookie.name}=${cookie.value}')
              .join('; '),
        });
      } catch (_) {
        if (!result.isCompleted) {
          result.completeError(const FormatException('Invalid stream'));
        }
      }
    });
    final initialized = parser.onInitialized.first.timeout(
      const Duration(seconds: 10),
    );
    initialized
        .ignore(); // init failure may close the stream before we await it.
    try {
      await parser.init().timeout(const Duration(seconds: 10));
      await initialized;
      await parser
          .loadUrl(episodeURL, plugin.useLegacyParser)
          .timeout(remaining());
      return await result.future.timeout(remaining());
    } finally {
      await events.cancel();
      await logs.cancel();
      await parser.dispose().timeout(
        const Duration(seconds: 2),
        onTimeout: () {},
      );
    }
  }
}
