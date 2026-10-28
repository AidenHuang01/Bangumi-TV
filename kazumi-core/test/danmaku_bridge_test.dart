import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:bangumi_kazumi_core/danmaku_bridge.dart';
import 'package:bangumi_kazumi_core/main.dart';

void main() {
  test(
    'HTTP danmaku bridge is private and independent of video providers',
    () async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      final worker = CoreWorker(
        token: 'private-token',
        port: server.port,
        plugins: {},
      );
      server.listen(worker.handle);
      final client = HttpClient();
      try {
        final url = Uri.parse('http://127.0.0.1:${server.port}/danmaku/search');
        final unauthorized = await client.postUrl(url);
        final denied = await unauthorized.close();
        expect(denied.statusCode, 401);
        await denied.drain<void>();
        final request = await client.postUrl(url);
        request.headers.set('Authorization', 'Bearer private-token');
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode({'anime': '芙莉莲'}));
        final response = await request.close();
        expect(response.statusCode, 503);
        final body = await utf8.decoder.bind(response).join();
        expect(body, contains('no API credentials'));
        expect(body, isNot(contains('private-token')));
      } finally {
        client.close(force: true);
        await server.close(force: true);
      }
    },
  );
  test(
    'missing release credentials are explicit and never trigger network',
    () async {
      var called = false;
      final bridge = KazumiDanmakuBridge(
        configured: false,
        search: (_) async {
          called = true;
          return {};
        },
      );
      await expectLater(
        bridge.handle('/danmaku/search', {'anime': '芙莉莲'}),
        throwsA(
          isA<DanmakuBridgeException>().having((e) => e.status, 'status', 503),
        ),
      );
      expect(called, false);
    },
  );

  test(
    'native bridge delegates show, episode and comment operations',
    () async {
      final bridge = KazumiDanmakuBridge(
        configured: true,
        search: (title) async => {
          'animes': [
            {'animeId': 12, 'animeTitle': title},
          ],
        },
        episodes: (id) async => {
          'bangumi': {
            'animeId': id,
            'episodes': [
              {'episodeId': 120001},
            ],
          },
        },
        comments: (id) async => {
          'comments': [
            {'m': 'hello', 'p': '1,1,16777215,u'},
          ],
        },
      );
      final search = await bridge.handle('/danmaku/search', {'anime': ' 芙莉莲 '});
      expect((search['animes'] as List).first['animeTitle'], '芙莉莲');
      final episodes = await bridge.handle('/danmaku/episodes', {
        'animeId': 12,
      });
      expect(episodes['bangumi']['animeId'], 12);
      final comments = await bridge.handle('/danmaku/comments', {
        'episodeId': 120001,
      });
      expect((comments['comments'] as List).first['m'], 'hello');
      await expectLater(
        bridge.handle('/danmaku/comments', {'episodeId': -1}),
        throwsFormatException,
      );
      await expectLater(
        bridge.handle('/danmaku/search', {'anime': ''}),
        throwsFormatException,
      );
    },
  );

  test(
    'upstream exceptions are sanitized and concurrency is bounded',
    () async {
      final pending = Completer<Map<String, dynamic>>();
      final bridge = KazumiDanmakuBridge(
        configured: true,
        search: (_) => pending.future,
      );
      final a = bridge.handle('/danmaku/search', {'anime': 'a'});
      final b = bridge.handle('/danmaku/search', {'anime': 'b'});
      await expectLater(
        bridge.handle('/danmaku/search', {'anime': 'c'}),
        throwsA(
          isA<DanmakuBridgeException>().having((e) => e.status, 'status', 429),
        ),
      );
      final checkA = expectLater(
        a,
        throwsA(
          isA<DanmakuBridgeException>().having(
            (e) => e.message,
            'message',
            failedDanmakuRequest,
          ),
        ),
      );
      final checkB = expectLater(b, throwsA(isA<DanmakuBridgeException>()));
      pending.completeError(Exception('private URL and secret headers'));
      await Future.wait([checkA, checkB]);
    },
  );
}
