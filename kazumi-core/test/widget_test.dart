import 'package:bangumi_kazumi_core/main.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:kazumi/plugins/plugins.dart';

void main() {
  test('API source IDs are not normalized into page URLs', () {
    final plugin = Plugin.fromJson({
      'name': 'fixture',
      'baseURL': 'https://source.example/',
      'chapterMode': 'api',
    });
    final worker = CoreWorker(
      token: 'test',
      port: 8789,
      plugins: {'fixture': plugin},
    );
    expect(worker.sourceReference('12345', plugin), '12345');
  });
  testWidgets('worker status', (tester) async {
    await tester.pumpWidget(const CoreStatus(message: 'Kazumi core running'));
    expect(find.text('Kazumi core running'), findsOneWidget);
  });
}
