// SPDX-License-Identifier: GPL-3.0-or-later
import 'dart:async';
import 'package:kazumi/request/apis/danmaku_api.dart';
import 'package:kazumi/utils/dandan_credentials.dart';

const missingDanmakuCredentials =
    'Kazumi danmaku has no API credentials. Rebuilding open source does not include official release credentials. Local JSON import is available.';
const failedDanmakuRequest =
    'Kazumi danmaku request failed. Check API authorization, quota and network.';
const busyDanmakuRequest = 'Kazumi danmaku is busy. Try again shortly.';

class DanmakuBridgeException implements Exception {
  const DanmakuBridgeException(this.message, this.status);
  final String message;
  final int status;
}

/// Extends the native worker, using Kazumi's original API and comment model.
/// No official-release secrets are extracted or copied into this project.
class KazumiDanmakuBridge {
  KazumiDanmakuBridge({
    bool? configured,
    Future<Map<String, dynamic>> Function(String)? search,
    Future<Map<String, dynamic>> Function(int)? episodes,
    Future<Map<String, dynamic>> Function(int)? comments,
  }) : configured =
           configured ??
           (dandanCredentials['id']!.isNotEmpty &&
               dandanCredentials['value']!.isNotEmpty),
       _search = search ?? _originalSearch,
       _episodes = episodes ?? _originalEpisodes,
       _comments = comments ?? _originalComments;

  final bool configured;
  final Future<Map<String, dynamic>> Function(String) _search;
  final Future<Map<String, dynamic>> Function(int) _episodes;
  final Future<Map<String, dynamic>> Function(int) _comments;
  int _active = 0;

  static Future<Map<String, dynamic>> _originalSearch(String title) async {
    final result = await DanmakuApi.searchAnimes(title);
    return {
      'animes': result.animes
          .take(25)
          .map(
            (anime) => {
              'animeId': anime.animeId,
              'animeTitle': anime.animeTitle,
              'typeDescription': anime.typeDescription,
            },
          )
          .toList(),
      'hasMore': result.hasMore || result.animes.length > 25,
    };
  }

  static Future<Map<String, dynamic>> _originalEpisodes(int animeId) async {
    final result = await DanmakuApi.getDanDanEpisodesByDanDanBangumiID(animeId);
    return {
      'bangumi': {
        'animeId': result.bangumiId,
        'episodes': result.episodes.take(1000).map((e) => e.toJson()).toList(),
      },
    };
  }

  static Future<Map<String, dynamic>> _originalComments(int episodeId) async {
    final result = await DanmakuApi.getDanDanmakuByEpisodeID(episodeId);
    return {'comments': result.take(20000).map((e) => e.toJson()).toList()};
  }

  Future<Map<String, dynamic>> handle(
    String operation,
    Map<String, dynamic> input,
  ) async {
    if (!configured) {
      throw const DanmakuBridgeException(missingDanmakuCredentials, 503);
    }
    if (_active >= 2) {
      throw const DanmakuBridgeException(busyDanmakuRequest, 429);
    }
    Future<Map<String, dynamic>> Function() action;
    if (operation == '/danmaku/search') {
      final title = input['anime'];
      if (title is! String || title.trim().isEmpty || title.length > 100) {
        throw const FormatException('Invalid anime title');
      }
      action = () => _search(title.trim());
    } else {
      final field = operation == '/danmaku/episodes' ? 'animeId' : 'episodeId';
      final id = input[field];
      if (!['/danmaku/episodes', '/danmaku/comments'].contains(operation) ||
          id is! int ||
          id <= 0 ||
          id > 9007199254740991) {
        throw const FormatException('Invalid danmaku operation or ID');
      }
      action = () =>
          operation == '/danmaku/episodes' ? _episodes(id) : _comments(id);
    }
    _active++;
    // Keep the slot until the original request finishes, even on timeout.
    final request = Future.sync(action).whenComplete(() => _active--);
    try {
      return await request.timeout(const Duration(seconds: 18));
    } catch (_) {
      // Upstream errors can contain URLs/headers. Never expose them to clients.
      throw const DanmakuBridgeException(failedDanmakuRequest, 502);
    }
  }
}
