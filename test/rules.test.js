// U8 (threshold), U9 (permission gate), U14 (traceability), U20 (ask format), U19 (facts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, score, bar } from '../lib/engine/threshold.js';
import { classify, allowed } from '../lib/engine/classify.js';
import { parseRequirements, parseVerificationPlan, parseSpecs, parsePlan, expandIds } from '../lib/engine/docs.js';
import { formatQuestion, Run } from '../lib/engine/run.js';
import * as T from '../lib/engine/tree.js';
import { initialState, reduce } from '../lib/engine/reducer.js';
import { REQUIREMENTS, VP, SPECS, PLAN, PRD, tmpdir } from './helpers.js';

function tree() {
  const s = initialState();
  const ctx = { requirements: ['A1', 'B1'] };
  const ap = (r) => reduce(s, { seq: 1, ts: 't', type: 'tree', data: { patch: r.patch } });
  ap(T.init(s.tree, { requirements: ['A1', 'B1'] }));
  ap(
    T.split(
      s.tree,
      'N',
      [
        { title: 'a', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] }, kind: 'behaviour', checks: [{ command: 'true' }], provides: [{ name: 'api' }] },
        { title: 'b', doneWhen: ['y'], covers: ['N#B1'], traces: { requirements: ['B1'] }, kind: 'behaviour', checks: [{ command: 'true' }], uses: ['C:N.1:api'] },
      ],
      ctx,
    ),
  );
  return s.tree;
}

test('U8: score counts proof; leaf bars move with the dial', () => {
  assert.equal(score({ source: true, test: true, fitsContract: false, secondAgent: null }), 2);
  const t = tree();
  const d = (dial, proof) => decide(t, dial, { id: 'D1', what: 'w', choice: 'c', change: { nodeId: 'N.2' }, proof }).outcome;
  const two = { source: true, test: true };
  assert.equal(d('careful', two), 'park');
  assert.equal(d('balanced', two), 'proceed');
  assert.equal(d('bold', { source: true }), 'proceed');
  assert.equal(d('balanced', { source: true }), 'park');
});

test('U8: radius comes from the ripple preview, not the claim; shared needs a second agent', () => {
  const t = tree();
  const shared = { change: { nodeId: 'N.1', contracts: ['C:N.1:api'] }, what: 'change api', choice: 'x' };
  const r1 = decide(t, 'balanced', { ...shared, proof: { source: true, test: true, fitsContract: true } });
  assert.equal(r1.radius, 'shared');
  assert.equal(r1.outcome, 'park', 'no second agent');
  const r2 = decide(t, 'balanced', { ...shared, proof: { source: true, test: true, fitsContract: true, secondAgent: true } });
  assert.equal(r2.outcome, 'proceed');
});

test('U8/J1: contract, irreversible and remote changes always park, whatever the proof and dial', () => {
  const t = tree();
  const all = { source: true, test: true, fitsContract: true, secondAgent: true };
  for (const change of [{ touchesDocs: true }, { irreversible: true }, { remote: true }]) {
    for (const dial of ['careful', 'balanced', 'bold']) {
      assert.equal(decide(t, dial, { what: 'x', choice: 'y', change: { nodeId: 'N.2', ...change }, proof: all }).outcome, 'park');
    }
  }
  assert.deepEqual(bar('bold', 'remote'), { always: 'park' });
});

test('U8/J10: below the bar the run parks the node and queues the question; answering unparks it', () => {
  const session = tmpdir();
  const run = Run.create({ sessionFolder: session, prdText: PRD });
  run.store.commit('doc', { key: 'requirements', sha: 'x', ids: ['A1', 'B1'] });
  run.tree('init', { requirements: ['A1', 'B1'] });
  run.tree('split', 'N', [
    { title: 'a', doneWhen: ['x'], covers: ['N#A1'], traces: { requirements: ['A1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
    { title: 'b', doneWhen: ['y'], covers: ['N#B1'], traces: { requirements: ['B1'] }, kind: 'behaviour', checks: [{ command: 'true' }] },
  ]);
  run.set('dial', 'careful');
  const rec = run.decide({ what: 'which date lib', choice: 'none', options: ['none', 'luxon'], change: { nodeId: 'N.1' }, proof: { source: true }, question: 'Use a date library?' });
  assert.equal(rec.outcome, 'park');
  assert.equal(run.state.tree.nodes['N.1'].status, 'parked');
  assert.equal(run.openQueue().length, 1);
  assert.equal(run.openQueue()[0].text, 'Use a date library?');
  assert.equal(run.state.tree.nodes['N.2'].status, 'ready', 'independent work continues');
  run.answerQueued([{ id: rec.questionId, answer: 'none' }]);
  assert.equal(run.openQueue().length, 0);
  assert.equal(run.state.tree.nodes['N.1'].status, 'ready');
  assert.equal(run.state.ledger[0].outcome, 'park');
});

test('U9: remote writes are classified and blocked without permission; reads pass', () => {
  const cases = [
    ['git push origin junior-dev/x', 'remote-write'],
    ['git -C app push origin HEAD:junior-dev/x', 'remote-write'],
    ['git fetch origin', 'remote-read'],
    ['git commit -m "push it"', 'local'],
    ['gh pr create --fill', 'remote-write'],
    ['gh pr view 12', 'remote-read'],
    ['gh api repos/o/r/issues -f title=x', 'remote-write'],
    ['gh api repos/o/r', 'remote-read'],
    ['curl -X POST https://x', 'remote-write'],
    ['curl https://x | jq .', 'remote-read'],
    ['npm test && npm publish', 'remote-write'],
    ['psql -h db.prod.internal -c "drop table x"', 'remote-write'],
    ['psql -h localhost -c "select 1"', 'local'],
    ['aws s3 ls', 'remote-write'],
    ['aws ec2 describe-instances', 'remote-read'],
    ['kubectl get pods', 'remote-read'],
    ['kubectl delete pod x', 'remote-write'],
    ['echo $(git push origin junior-dev/x)', 'remote-write'],
    ['FOO=1 sudo terraform apply', 'remote-write'],
    ['ls -la; npm run build', 'local'],
  ];
  for (const [cmd, kind] of cases) assert.equal(classify('bash', { command: cmd }).kind, kind, cmd);
  assert.equal(classify('mcp__jira__createIssue', {}).kind, 'remote-write');
  assert.equal(classify('mcp__jira__searchIssues', {}).kind, 'remote-read');
  assert.equal(classify('read_file', {}).kind, 'local');

  const none = { push: false, pr: false, remoteWrites: [] };
  const push = { push: true, pr: true, remoteWrites: [] };
  assert.equal(allowed(none, classify('bash', { command: 'git push origin junior-dev/x' })).ok, false);
  assert.equal(allowed(push, classify('bash', { command: 'git push origin junior-dev/x' })).ok, true);
  assert.equal(allowed(push, classify('bash', { command: 'git push origin main' })).ok, false, 'only junior-dev/* branches');
  assert.equal(allowed(push, classify('bash', { command: 'git push --force origin junior-dev/x' })).ok, false, 'never force');
  assert.equal(allowed(push, classify('bash', { command: 'git push' })).ok, false, 'branch must be explicit');
  assert.equal(allowed(none, classify('bash', { command: 'gh pr create' })).ok, false);
  assert.equal(allowed(push, classify('bash', { command: 'gh pr create --fill' })).ok, true);
  assert.equal(allowed(push, classify('bash', { command: 'gh pr merge 3' })).ok, false, 'merge is not PR creation');
  assert.equal(allowed(none, classify('bash', { command: 'git fetch' })).ok, true);
  assert.equal(allowed({ ...none, remoteWrites: ['mcp:mcp__jira__createIssue'] }, classify('mcp__jira__createIssue')).ok, true);
});

test('U9 (iOS research): App Store Connect, notary and Transporter uploads are remote writes, through xcrun and bundle exec too', () => {
  const cases = [
    ['xcrun altool --upload-app -f App.ipa -t ios -u me@x.com -p @keychain:AC', 'remote-write'],
    ['altool --upload-package App.ipa --apple-id 123 --bundle-id x', 'remote-write'],
    ['sudo /usr/bin/xcrun altool --upload-app -f App.ipa', 'remote-write'],
    ['xcrun altool --validate-app -f App.ipa -t ios', 'remote-read'],
    ['xcrun notarytool submit App.zip --keychain-profile p --wait', 'remote-write'],
    ['xcrun notarytool history --keychain-profile p', 'remote-read'],
    ['xcrun notarytool store-credentials p', 'local'],
    ['iTMSTransporter -m upload -assetFile App.ipa', 'remote-write'],
    ['xcrun iTMSTransporter -m upload -assetFile App.ipa', 'remote-write'],
    ['/Applications/Transporter.app/Contents/itms/bin/iTMSTransporter -m upload -f pkg.itmsp', 'remote-write'],
    ['xcrun iTMSTransporter -m lookupMetadata -apple_id 1', 'remote-read'],
    ['xcodebuild -exportArchive -archivePath App.xcarchive -exportOptionsPlist ExportOptions.plist -exportPath out', 'remote-write'],
    ['xcrun xcodebuild -exportArchive -archivePath App.xcarchive -exportOptionsPlist e.plist', 'remote-write'],
    ['xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 17" test', 'local'],
    ['xcodebuild archive -scheme App -archivePath App.xcarchive', 'local'],
    ['xcrun simctl boot "iPhone 17"', 'local'],
    ['xcrun --sdk iphoneos --show-sdk-path', 'local'],
    ['xcrun -f altool', 'local'],
    ['fastlane pilot upload --ipa App.ipa', 'remote-write'],
    ['fastlane deliver --force', 'remote-write'],
    ['fastlane upload_to_testflight', 'remote-write'],
    ['bundle exec fastlane upload_to_app_store', 'remote-write'],
    ['fastlane run upload_to_testflight', 'remote-write'],
    ['fastlane ios beta', 'remote-write'],
    ['bundle exec fastlane --env prod release', 'remote-write'],
    ['fastlane gym', 'remote-write'],
    ['fastlane scan', 'local'],
    ['bundle exec fastlane ios run_tests', 'local'],
    ['fastlane lanes', 'local'],
    ['fastlane --version', 'local'],
    ['fastlane pilot builds', 'remote-read'],
    ['xcodebuild test && xcrun altool --upload-app -f App.ipa', 'remote-write'],
  ];
  for (const [cmd, kind] of cases) assert.equal(classify('bash', { command: cmd }).kind, kind, cmd);

  const none = { push: false, pr: false, remoteWrites: [] };
  for (const cmd of ['xcrun altool --upload-app -f App.ipa', 'xcrun notarytool submit App.zip', 'fastlane pilot upload', 'fastlane deliver', 'xcodebuild -exportArchive -exportOptionsPlist e.plist', 'xcrun iTMSTransporter -m upload']) {
    const v = allowed(none, classify('bash', { command: cmd }));
    assert.equal(v.ok, false, cmd);
    assert.match(v.reason, /was not permitted in the interview/);
  }
  const ok = (remoteWrites, cmd) => allowed({ ...none, remoteWrites }, classify('bash', { command: cmd })).ok;
  assert.equal(ok(['altool-upload'], 'xcrun altool --upload-app -f App.ipa'), true);
  assert.equal(ok(['notarytool-submit'], 'xcrun notarytool submit App.zip --wait'), true);
  assert.equal(ok(['fastlane'], 'bundle exec fastlane pilot upload'), true);
  assert.equal(ok(['xcodebuild-export'], 'xcodebuild -exportArchive -exportOptionsPlist e.plist'), true);
  assert.equal(ok(['transporter'], 'iTMSTransporter -m upload -assetFile a.ipa'), true);
  assert.equal(ok(['notarytool-submit'], 'xcrun altool --upload-app -f App.ipa'), false, 'one permission does not cover another upload');
  assert.equal(ok([], 'xcrun notarytool history'), true, 'remote reads pass');
});

test('U9 (iOS research): Xcode MCP tools are local (file writes flagged for the gate) or remote reads, whatever the server is called', () => {
  for (const server of ['xcode', 'my_xcode']) {
    for (const tool of ['XcodeWrite', 'XcodeUpdate', 'XcodeRM', 'XcodeMV', 'XcodeMakeDir', 'XcodeInsertFile', 'UpdateTargetBuildSetting', 'AddEntitlement', 'AddInfoPlist', 'UpdateFileCompilerFlags', 'XcodeMessageSend']) {
      const c = classify(`mcp__${server}__${tool}`, {});
      assert.deepEqual([c.kind, c.writes], ['local', true], tool);
    }
    for (const tool of ['BuildProject', 'RunProject', 'RunAllTests', 'RunSomeTests', 'RenderPreview', 'XcodeRead', 'XcodeLS', 'GetBuildLog', 'XcodeListWindows']) {
      const c = classify(`mcp__${server}__${tool}`, {});
      assert.deepEqual([c.kind, c.writes], ['local', undefined], tool);
    }
    for (const tool of ['DocumentationSearch', 'GetTopCrashIssues', 'GetCrashIssueLogs', 'GetTopFieldPerformanceIssues']) assert.equal(classify(`mcp__${server}__${tool}`, {}).kind, 'remote-read', tool);
  }
  const none = { push: false, pr: false, remoteWrites: [] };
  assert.equal(allowed(none, classify('mcp__xcode__UpdateTargetBuildSetting', { buildSettingName: 'SWIFT_VERSION', buildSettingValue: '6.0' })).ok, true, 'a local project setting, not a remote write');
  assert.equal(allowed(none, classify('mcp__xcode__XcodeWrite', { filePath: 'App/Sources/A.swift', content: 'x' })).ok, true);
  // other servers keep the verb rule
  assert.equal(classify('mcp__jira__updateIssue', {}).kind, 'remote-write');
  assert.equal(classify('mcp__ci__addBuild', {}).kind, 'remote-write');
  assert.equal(classify('mcp__ci__XcodeWriteLog', {}).kind, 'remote-read', 'only the known Xcode names');
});

test('U14: requirements, VP, specs and plan validators enforce full traceability', () => {
  const r = parseRequirements(REQUIREMENTS);
  assert.ok(r.ok);
  assert.deepEqual(r.ids, ['A1', 'A2', 'B1']);
  const vp = parseVerificationPlan(VP, r.ids);
  assert.ok(vp.ok, vp.reasons.join());
  assert.deepEqual(vp.checks.map((c) => [c.id, c.kind, c.proves.join('+')]), [['U1', 'automated', 'A1+A2'], ['U2', 'automated', 'B1'], ['H1', 'human', 'A1']]);
  assert.equal(vp.checks[0].command, 'node --test');
  assert.ok(!parseVerificationPlan(VP.replace('| H1 | human |', '| H1 | maybe |'), r.ids).ok);
  const sp = parseSpecs(SPECS, r.ids);
  assert.ok(sp.ok, sp.reasons.join());
  assert.deepEqual(parseSpecs(SPECS.replace('[B1]', ''), r.ids).uncited, ['B1']);
  const pl = parsePlan(PLAN, ['S1', 'S2'], ['U1', 'U2', 'H1']);
  assert.ok(pl.ok, pl.reasons.join());
  assert.equal(pl.commands.U2.command, `node -e "import('./index.js')"`);
  assert.match(parsePlan(PLAN.replace('| P2 | export | S2 | U2 |', '| P2 | export | S9 | |'), ['S1', 'S2'], ['U1', 'U2']).reasons.join(), /unknown spec items: S9.*cites no check/);
  assert.deepEqual(expandIds('J1–J3, A2', ['J1', 'J2', 'J3', 'A2']), ['J1', 'J2', 'J3', 'A2']);
});

test('U20: questions are single, plain, multiple-choice with the recommended option first, free answer allowed', () => {
  const q = formatQuestion({ id: 'Q1', question: 'Push when done?', options: ['No', 'Yes'], recommended: 'Yes' });
  assert.deepEqual(q.options.map((o) => o.label), ['Yes (Recommended)', 'No']);
  assert.equal(q.freeAnswer, true);
  assert.throws(() => formatQuestion({ question: '', options: [] }));
  assert.throws(() => formatQuestion({ question: 'x?', options: ['a', 'b', 'c', 'd', 'e'] }));
  assert.throws(() => formatQuestion({ question: 'x?', options: ['only'] }));
  assert.equal(formatQuestion({ question: 'Name?' }).options.length, 0, 'open question allowed');
});

test('U19: research facts keep their source; a developer override wins and is recorded', () => {
  const run = Run.create({ sessionFolder: tmpdir(), prdText: PRD });
  const id = run.addFact('tests run with jest', 'package.json scripts.test');
  run.overrideFact(id, 'tests run with node --test');
  const f = run.state.facts[0];
  assert.equal(f.source, 'package.json scripts.test');
  assert.equal(f.override.text, 'tests run with node --test');
});

test('R1 finding: table cells keep shell pipes inside code spans (`a || b`, escaped \\|)', async () => {
  const { splitRow } = await import('../lib/engine/docs.js');
  assert.deepEqual(splitRow('| U4 | automated | x | B1 | `node -e "if(a||b)process.exit(1)"` |'), ['U4', 'automated', 'x', 'B1', '`node -e "if(a||b)process.exit(1)"`']);
  assert.deepEqual(splitRow('| a \\| b | c |'), ['a | b', 'c']);
  const fs = await import('node:fs');
  const md = fs.readFileSync(new URL('./fixtures-r1-verification-plan.md', import.meta.url), 'utf8');
  const vp = parseVerificationPlan(md, ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'C1', 'C2']);
  assert.ok(vp.ok, vp.reasons.join('; '));
  const u4 = vp.checks.find((c) => c.id === 'U4');
  assert.match(u4.command, /a\.slugify!==b\.slugify\)process\.exit\(1\)\}\)"$/);
  const u5 = vp.checks.find((c) => c.id === 'U5');
  assert.match(u5.command, /p\.dependencies\|\|p\.devDependencies/);
});

test('U14b (v2-09): plan validators accept and trace tool checks, and reject one with no pass rule', () => {
  const r = parseRequirements(REQUIREMENTS);
  const tool = '`tool:xcode_build {"scheme":"App","a|b":1} pass:build_ok`';
  const vpMd = VP.replace('`node --test`', tool);
  const vp = parseVerificationPlan(vpMd, r.ids);
  assert.ok(vp.ok, vp.reasons.join());
  const u1 = vp.checks.find((c) => c.id === 'U1');
  assert.equal(u1.command, null);
  assert.deepEqual([u1.tool, u1.arguments, u1.pass], ['xcode_build', { scheme: 'App', 'a|b': 1 }, 'build_ok']);
  assert.deepEqual(u1.proves, ['A1', 'A2'], 'still traced');
  const noRule = parseVerificationPlan(vpMd.replace(' pass:build_ok', ''), r.ids);
  assert.ok(!noRule.ok);
  assert.match(noRule.reasons.join(), /U1: tool check "xcode_build" has no pass rule/);
  assert.match(parseVerificationPlan(vpMd.replace('{"scheme"', '{scheme'), r.ids).reasons.join(), /not valid JSON/);
  const pl = parsePlan(PLAN.replace(/^\| U2 \|.*$/m, `| U2 | ${tool.replace('xcode_build', 'xcode_test')} | |`), ['S1', 'S2'], ['U1', 'U2', 'H1']);
  assert.ok(pl.ok, pl.reasons.join());
  assert.equal(pl.commands.U2.tool, 'xcode_test');
  assert.equal(pl.commands.U2.command, null);
  assert.ok(!parsePlan(PLAN.replace(/^\| U2 \|.*$/m, '| U2 | `tool:xcode_test {}` | |'), ['S1', 'S2'], ['U1', 'U2', 'H1']).ok);
});
