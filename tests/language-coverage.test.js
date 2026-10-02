'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { validTag, statistics, nginxStatement, readmeStatement, checkReadme } = require('../scripts/language-catalog');
const { buildAudit, digest, lookup, preferredLocale, renderGaps, replayIsCurrent } = require('../scripts/audit-coverage');
const ROOT = path.resolve(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const catalog = read('languages.json');

test('recognizes registered lowercase language, script and region filename tags', () => {
    for (const tag of ['en', 'bho', 'ckb', 'zh-hant', 'zh-hant-tw', 'sr-latn', 'fa-af', 'es-419']) assert.equal(validTag(tag), true, tag);
    for (const tag of ['vn', 'zz', 'de-DE', 'zh-fake', 'de-999', 'en--us', 'en-us-latn', '../en']) assert.equal(validTag(tag), false, tag);
});

test('README has exactly the catalog statement, with English first and each filename once', () => {
    assert.deepEqual(checkReadme(catalog), []);
    const statement = readmeStatement();
    const tags = statement.replace(/^set_from_accept_language\s+\$lang\s+/u, '').replace(/;$/u, '').trim().split(/\s+/u);
    assert.equal(tags[0], 'en');
    assert.equal(tags.length, new Set(tags).size);
    assert.deepEqual([...tags].sort(), catalog.languages.map(l => l.tag).sort());
    const changed = structuredClone(catalog);
    changed.languages.push({ tag: 'en-gb', languageId: 'en' });
    assert.notDeepEqual(checkReadme(changed), []);
    assert.match(nginxStatement(changed), /en-gb/u);
    const counts = statistics(catalog);
    assert.ok(counts.languages >= 100);
    assert.ok(counts.files > counts.languages);
    assert.equal(catalog.baselineTags.length, 100);
});

test('explicit routing covers Traditional Chinese and distinct written standards', () => {
    const tags = new Set(catalog.languages.map(l => l.tag));
    const byTag = new Map(catalog.languages.map(l => [l.tag, l]));
    for (const [request, expected] of [['de-DE', 'de'], ['zh-TW', 'zh-tw'], ['zh-HK', 'zh-hk'], ['zh-MO', 'zh-mo'], ['zh-Hant-TW', 'zh-hant-tw'], ['sr-Latn-RS', 'sr-latn'], ['nn-NO', 'nn'], ['ku-ARAB-IQ', 'ku-arab'], ['prs-AF', 'prs']]) {
        assert.equal(lookup(request, tags), expected, request);
    }
    for (const tag of ['zh-tw', 'zh-hk', 'zh-mo']) assert.match(byTag.get(tag).writtenForm, /Traditional/u);
    assert.equal(byTag.get('nn').languageId, byTag.get('nb').languageId);
    assert.equal(byTag.get('ckb').languageId, byTag.get('ku').languageId);
    assert.equal(lookup('de-DE-u-co-phonebk', tags), 'de');
    assert.equal(lookup('xx,fr-CA;q=0.9,de;q=0.8', tags), 'fr');
    assert.equal(lookup(null, tags), 'en');
    assert.equal(lookup('xx-ZZ', tags), 'en');
    assert.equal(preferredLocale({ country: 'TW', language: 'zh-hans' }, 'Hans'), 'zh-hans-TW');
    assert.equal(preferredLocale({ country: 'TW', language: 'zh-hant' }, 'Hant'), 'zh-TW');
    assert.equal(lookup('zh-Hans-TW', tags), 'zh');
    assert.equal(lookup('zh-Hant-CN', tags), 'zh-hant');
});

test('pinned datasets retain their recorded source hashes', () => {
    for (const source of read('coverage/sources/manifest.json')) {
        assert.equal(sha(fs.readFileSync(path.join(ROOT, 'coverage/sources', source.file))), source.sha256, source.file);
        assert.ok(source.url.startsWith('https://'));
        assert.ok(source.retrieved);
    }
});

test('audit is reproducible and every country has a sourced disposition', () => {
    const audit = read('coverage/audit.json');
    assert.deepEqual(audit, buildAudit(), 'run npm run audit:coverage');
    assert.equal(audit.countries.length, 250);
    assert.equal(new Set(audit.countries.map(c => c.code)).size, 250);
    assert.ok(audit.countries.some(c => c.code === 'XK'));
    for (const country of audit.countries) {
        assert.ok(country.disposition);
        if (!country.cases) assert.ok(country.sources.length, country.code);
    }
    const groups = new Map();
    for (const row of audit.cases) {
        const key = `${row.country}/${row.language}`;
        if (!groups.has(key)) groups.set(key, new Set());
        groups.get(key).add(`${row.client}/${row.mode}`);
        assert.ok(row.statusSources.length, row.id);
        assert.ok(row.speakers.kind, row.id);
        if (row.speakers.estimate != null || row.speakers.percentage != null) {
            assert.ok(row.speakers.source && row.speakers.year, row.id);
        }
        assert.match(row.profileEvidence, /Source-derived|Synthetic/u);
        if (row.expectedLocale === 'en' && row.language.split('-')[0] !== 'en') assert.ok(row.issues.length, row.id);
    }
    for (const [key, profiles] of groups) assert.deepEqual([...profiles].sort(), ['chrome/ordered', 'chrome/reduced', 'edge/ordered', 'firefox/ordered', 'windows/ordered'], key);
});

test('saved nginx replay covers current translations, exact statement and full audit', () => {
    const audit = read('coverage/audit.json');
    const results = read('coverage/nginx-results.json');
    assert.equal(replayIsCurrent(audit, results), true);
    const stale = structuredClone(results);
    stale.translationSha256.de = 'stale';
    assert.equal(replayIsCurrent(audit, stale), false, 'a translation edit invalidates the replay even if its filename is unchanged');
    assert.equal(results.auditSha256, digest(audit), 'rerun npm run test:nginx');
    assert.equal(results.catalogSha256, digest(catalog));
    assert.equal(results.statementSha256, sha(readmeStatement()));
    assert.equal(results.nginxConfigTest.exitCode, 0);
    assert.equal(results.startup, true);
    assert.ok(results.build.moduleSourceHashes['ngx_http_accept_language_module.c']);
    assert.equal(results.localeRequests, catalog.languages.length * 2);
    for (const { tag } of catalog.languages) {
        assert.equal(results.translationSha256[tag], sha(fs.readFileSync(path.join(ROOT, 'language', `${tag}.json`))), `${tag}: replay is stale`);
        assert.equal(results.supportedLocales.filter(row => row.expectedLocale === tag).length, 2, tag);
    }
    assert.deepEqual(results.cases.map(c => c.id), audit.cases.map(c => c.id));
    for (const row of [...results.supportedLocales, ...results.focusedCases, ...results.cases]) {
        assert.equal(row.status, 200, row.id);
        assert.equal(row.matchesFile, true, row.id);
        assert.equal(row.selectedLocale, row.expectedLocale, row.id);
    }
    assert.equal(fs.readFileSync(path.join(ROOT, 'GAPS.md'), 'utf8'), renderGaps(audit, results));
});
