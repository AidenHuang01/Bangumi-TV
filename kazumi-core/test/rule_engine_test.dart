import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/plugins/api_rule_config.dart';
import 'package:kazumi/plugins/anti_crawler_config.dart';
import 'package:kazumi/services/plugin/rule_engine.dart';
import 'package:kazumi/services/plugin/rule_engine_models.dart';

class FixtureRequests implements RuleRequestExecutor {
  @override
  Future<String> execute(
    PreparedRuleRequest request,
    RuleExecutionConfig config, {
    RuleCancelToken? cancelToken,
  }) async {
    if (request.url.contains('/search')) {
      return '<html><body><div class="result"><a href="/show/1">葬送的芙莉莲</a></div></body></html>';
    }
    return '<html><body><ul class="episodes"><li><a href="/play/1">第01集</a></li>'
        '<li><a href="/play/2">第02集</a></li></ul></body></html>';
  }
}

void main() {
  test(
    'original Kazumi RuleEngine parses XPath search and episode roads',
    () async {
      final config = RuleExecutionConfig(
        pluginName: 'fixture',
        baseUrl: 'https://source.example',
        usePost: false,
        searchMode: 'xpath',
        chapterMode: 'xpath',
        searchUrl: 'https://source.example/search?q=@keyword',
        searchList: '//div[@class="result"]',
        searchName: './a',
        searchResult: './a',
        chapterRoads: '//ul[@class="episodes"]',
        chapterResult: './li/a',
        searchApiConfig: ApiSearchConfig(),
        chapterApiConfig: ApiChapterConfig(),
        antiCrawlerConfig: AntiCrawlerConfig.empty(),
      );
      final engine = RuleEngine(
        requestExecutor: FixtureRequests(),
        logFailures: false,
      );
      final search = await engine.search(config, '葬送的芙莉莲');
      expect(search.response.data.single.name, '葬送的芙莉莲');
      final chapters = await engine.queryChapters(
        config,
        search.response.data.single.src,
      );
      expect(chapters.roads.single.data, [
        'https://source.example/play/1',
        'https://source.example/play/2',
      ]);
      expect(chapters.roads.single.identifier, ['第01集', '第02集']);
    },
  );
}
