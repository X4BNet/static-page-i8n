#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readmeStatement } = require('./language-catalog');
const ROOT = path.resolve(__dirname, '..');
const read = filename => JSON.parse(fs.readFileSync(path.join(ROOT, filename), 'utf8'));
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalize = tag => tag.replaceAll('_', '-').toLowerCase();
const CLDR = 'https://github.com/unicode-org/cldr-json/blob/48.0.0/cldr-json/cldr-core/supplemental/territoryInfo.json';
const scriptNames = { Latn: 'Latin', Cyrl: 'Cyrillic', Arab: 'Arabic', Deva: 'Devanagari', Beng: 'Bengali', Ethi: 'Ethiopic', Grek: 'Greek', Gujr: 'Gujarati', Hebr: 'Hebrew', Armn: 'Armenian', Khmr: 'Khmer', Knda: 'Kannada', Laoo: 'Lao', Mlym: 'Malayalam', Mymr: 'Myanmar', Orya: 'Oriya', Guru: 'Gurmukhi', Sinh: 'Sinhala', Taml: 'Tamil', Telu: 'Telugu', Thai: 'Thai', Tfng: 'Tifinagh', Cans: 'Canadian_Aboriginal', Mong: 'Mongolian', Olck: 'Ol_Chiki', Tibt: 'Tibetan', Thaa: 'Thaana', Geor: 'Georgian' };

function languageNames() {
    const result = new Map();
    const registry = fs.readFileSync(path.join(ROOT, 'coverage/sources/language-subtag-registry.txt'), 'utf8');
    for (const record of registry.split('%%')) {
        if (/^Type: language$/mu.test(record)) {
            const tag = record.match(/^Subtag: (.+)$/mu)?.[1];
            const name = record.match(/^Description: (.+)$/mu)?.[1];
            if (tag && name) result.set(tag, name);
        }
    }
    return result;
}

// An independent, small lookup oracle for the documented module behavior.
// Quality weights are deliberately not interpreted: the module uses order.
function lookup(header, tags, defaultTag = 'en') {
    for (let range of (header || '').split(',').map(s => s.split(';')[0].trim().toLowerCase())) {
        if (!/^[a-z]{1,8}(?:-[a-z0-9]{1,8})*$/u.test(range)) continue;
        while (range) {
            if (tags.has(range)) return range;
            const parts = range.split('-');
            parts.pop();
            if (parts.length && parts.at(-1).length === 1) parts.pop();
            range = parts.join('-');
        }
    }
    return defaultTag;
}

function sourceScript(tag, country, likely) {
    const parts = tag.split('-');
    const explicit = parts.find(p => /^[a-z]{4}$/u.test(p));
    if (explicit) return explicit[0].toUpperCase() + explicit.slice(1);
    const language = parts[0];
    const region = parts.slice(1).find(p => /^(?:[a-z]{2}|[0-9]{3})$/u.test(p))?.toUpperCase() || country;
    const maximized = likely[`${language}-${region}`] || likely[`${language}_${region}`] || likely[language];
    return maximized?.split(/[-_]/u)[1] || null;
}

function makeHeader(preferred, client, mode) {
    if (mode === 'reduced') return preferred;
    const base = preferred.split('-')[0];
    const list = [...new Set(client === 'windows' ? [preferred, base, 'en-US', 'en'] : [preferred, base, 'en'])];
    return list.map((tag, index) => index === 0 ? tag : `${tag};q=${client === 'windows' ? ([1, 0.8, 0.5, 0.3][index] || 0.1).toFixed(1) : Math.max(0.1, 1 - index * 0.1).toFixed(1)}`).join(',');
}

function preferredLocale(record, script) {
    if (record.language.split('-')[0] === 'zh' && script === 'Hant' && ['TW', 'HK', 'MO'].includes(record.country)) return `zh-${record.country}`;
    return /-(?:[a-z]{2}|[0-9]{3})$/u.test(record.language) ? record.language : `${record.language}-${record.country}`;
}

function buildAudit() {
    const catalog = read('languages.json');
    const countries = read('coverage/countries.json').countries;
    const territories = read('coverage/sources/territoryInfo.json').supplemental.territoryInfo;
    const likely = read('coverage/sources/likelySubtags.json').supplemental.likelySubtags;
    const choices = read('coverage/browser-language-lists.json');
    const names = languageNames();
    const byTag = new Map(catalog.languages.map(l => [l.tag, l]));
    const tags = new Set(byTag.keys());
    const official = new Map();
    const exclusions = [], decisions = [], researchNotes = [], unresolvedMappings = [], censusEvidence = [];
    for (const country of countries) {
        const territory = territories[country.code];
        for (const [rawTag, population] of Object.entries(territory?.languagePopulation || {})) {
            if (!population._officialStatus) continue;
            const tag = normalize(rawTag);
            official.set(`${country.code}/${tag}`, {
                country: country.code, language: tag, status: population._officialStatus,
                statusBasis: 'CLDR functional official-status classification; see government corrections and limitations',
                sources: [CLDR],
                speakers: {
                    estimate: Math.round(Number(territory._population) * Number(population._populationPercent) / 100),
                    kind: 'CLDR language-population estimate; not a native-speaker count',
                    year: 'CLDR 48 snapshot; underlying observation years vary', source: CLDR,
                    method: `Territory population ${territory._population} × language share ${population._populationPercent}%`,
                },
            });
        }
    }
    const researchDirectory = path.join(ROOT, 'coverage/research');
    const researchFiles = fs.existsSync(researchDirectory) ? fs.readdirSync(researchDirectory).filter(f => f.endsWith('-status.json')).sort() : [];
    const evidence = {};
    for (const filename of researchFiles) {
        const report = read(`coverage/research/${filename}`);
        evidence[filename] = digest(report);
        for (const update of report.updates || []) {
            const tag = normalize(update.language);
            const key = `${update.country}/${tag}`;
            if (!countries.some(c => c.code === update.country)) throw new Error(`${filename}: unknown country ${update.country}`);
            if (!Array.isArray(update.sources) || !update.sources.length) throw new Error(`${filename}: missing sources for ${key}`);
            if (update.action === 'remove') {
                official.delete(key);
                exclusions.push({ ...update, language: tag });
            } else if (update.action === 'add') {
                const previous = official.get(key);
                const population = territories[update.country]?.languagePopulation?.[tag.replaceAll('-', '_')];
                const estimate = population && Math.round(Number(territories[update.country]._population) * Number(population._populationPercent) / 100);
                // A regional law can add scope without downgrading an existing
                // national designation (e.g. Hindi/English in Jammu and Kashmir).
                const status = update.regions && previous?.status === 'official' && update.status === 'official_regional' ? previous.status : update.status;
                official.set(key, {
                    ...previous, ...update, language: tag, statusBasis: 'Sourced official-status correction',
                    status, sources: [...new Set([...(previous?.sources || []), ...update.sources])],
                    speakers: update.speakers || previous?.speakers || (estimate !== undefined ? { estimate, kind: 'CLDR language-population estimate; not a native-speaker count', year: 'CLDR 48 snapshot; underlying observation years vary', source: CLDR } : { estimate: null, kind: 'Unknown; no reliable count found in the reviewed sources', year: null, source: null }),
                });
            } else throw new Error(`${filename}: unsupported action ${update.action}`);
        }
        for (const estimate of report.speakerEstimates || []) {
            const row = official.get(`${estimate.country}/${normalize(estimate.language)}`);
            if (row) row.speakers = estimate;
        }
        for (const census of report.censusSources || []) {
            censusEvidence.push({ ...census, report: filename });
            for (const [tag, percentage] of Object.entries(census.percentages || {})) {
                const row = official.get(`${census.country}/${tag}`);
                if (row) row.speakers = { estimate: null, percentage, kind: census.kind, year: census.year, source: census.source, note: census.note };
            }
        }
        decisions.push(...(report.territoryDispositions || []));
        researchNotes.push(...(report.notes || []).filter(note => typeof note === 'object').map(note => ({ ...note, report: filename })));
        unresolvedMappings.push(...(report.unresolvedMappings || []).map(note => ({ ...note, sourceGap: true, report: filename })));
    }
    const feasibility = read('coverage/translation-feasibility.json');
    for (const filename of ['coverage/countries.json', 'coverage/browser-language-lists.json', 'coverage/browser-captures.json', 'coverage/translation-feasibility.json', 'coverage/sources/manifest.json']) evidence[filename] = digest(read(filename));
    const profiles = [];
    for (const record of [...official.values()].sort((a, b) => `${a.country}/${a.language}`.localeCompare(`${b.country}/${b.language}`))) {
        const base = record.language.split('-')[0];
        const script = sourceScript(record.language, record.country, likely);
        const preferred = preferredLocale(record, script);
        const requiredLocale = record.requiredLocale || (base === 'fa' && record.country === 'AF' ? 'fa-af' : base === 'qu' && record.country === 'EC' ? 'qu-ec' : null);
        const signed = /sign|signed/iu.test(names.get(base) || '') || record.modality === 'signed';
        for (const client of ['windows', 'chrome', 'firefox', 'edge']) {
            const choiceSet = new Set(choices[client === 'chrome' ? 'chromium' : client].tags.map(normalize));
            let preferredTag = preferred;
            if (client === 'windows' && base === 'ckb') preferredTag = 'ku-Arab-IQ';
            if (client === 'windows' && base === 'fa' && record.country === 'AF') preferredTag = 'prs-AF';
            if (base === 'fil' && !choiceSet.has('fil') && choiceSet.has('tl')) preferredTag = 'tl';
            const candidate = normalize(preferredTag);
            const alternatives = [...choiceSet].filter(tag => tag.split('-')[0] === base && sourceScript(tag, '', likely) === script).sort((a, b) => b.length - a.length || a.localeCompare(b));
            const choice = [candidate, ...alternatives].find(tag => choiceSet.has(tag));
            const available = !!choice;
            // Use source-backed menu choices when possible. Retain a clearly labelled
            // synthetic probe when this language is absent from the published list.
            if (choice) preferredTag = choice;
            for (const mode of (client === 'chrome' ? ['ordered', 'reduced'] : ['ordered'])) {
                const header = makeHeader(preferredTag, client, mode);
                const selected = lookup(header, tags);
                const selectedLanguage = byTag.get(selected);
                const requestedLanguageId = ({ no: 'no', nb: 'no', nn: 'no', prs: 'fa', ckb: 'ku', tl: 'fil' })[base] || base;
                const matchingIdentity = (selectedLanguage.languageId || selectedLanguage.tag) === requestedLanguageId;
                const issues = [];
                if (signed) issues.push('signed-language-modality');
                else if (!matchingIdentity) issues.push(catalog.languages.some(locale => locale.languageId === requestedLanguageId) ? 'identifier-mismatch' : 'missing-translation');
                else {
                    if (requiredLocale && selected !== requiredLocale && selectedLanguage.aliasOf !== requiredLocale) issues.push('written-form-gap');
                    if (['nn', 'ckb'].includes(base) && selected !== base && selectedLanguage.aliasOf !== base) issues.push('written-form-gap');
                    if (script && scriptNames[script] && selectedLanguage.script !== scriptNames[script]) issues.push('script-gap');
                    if (base === 'zh' && ['Hans', 'Hant'].includes(script) && selectedLanguage.scriptCode !== script) issues.push('script-gap');
                }
                if (!available) issues.push('browser-profile-evidence-gap');
                const declined = feasibility.declined?.find(d => d.tag === requiredLocale || d.tag === record.language || d.tag === base);
                profiles.push({
                    id: `${record.country}/${record.language}/${client}/${mode}`,
                    country: record.country, language: record.language, languageName: names.get(base) || record.name || base,
                    officialStatus: record.status, statusBasis: record.statusBasis, statusSources: record.sources, statusReason: record.reason || null,
                    client, mode, preferredLocale: preferredTag, header,
                    profileEvidence: available ? 'Source-derived preference scenario using a published client language choice; not a captured country default' : 'Synthetic BCP 47 probe; no corresponding choice established in the reviewed client list',
                    profileSource: choices[client === 'chrome' ? 'chromium' : client].source,
                    expectedLocale: selected, requestedScript: script, requiredLocale,
                    issues: [...new Set(issues)], speakers: record.speakers,
                    translationFeasibility: declined?.reason || (issues.some(i => i !== 'browser-profile-evidence-gap') ? 'No complete reviewed translation for this required profile; retain for language-specific review.' : 'Reviewed translation exists; see catalog fluency notes.'),
                });
            }
        }
    }
    const countryResults = countries.map(country => {
        const cases = profiles.filter(p => p.country === country.code);
        const decision = decisions.find(d => d.country === country.code);
        const scopeReview = [...researchNotes, ...unresolvedMappings].filter(note => note.country === country.code && (note.sourceGap || note.statutoryName || note.statutoryNames));
        return { ...country, cases: cases.length, officialLanguageProfiles: new Set(cases.map(c => c.language)).size, disposition: cases.length ? (cases.some(c => c.issues.length) ? 'gaps' : scopeReview.length ? 'scope-review-required' : 'covered') : (decision?.disposition || 'official-status-evidence-gap'), ...(decision ? { note: decision.reason, sources: decision.sources } : {}), ...(scopeReview.length ? { scopeReview } : {}) };
    });
    return {
        schemaVersion: 1, snapshot: '2026-10-02', catalogSha256: digest(catalog), evidenceSha256: evidence,
        sources: {
            cldrVersion: '48.0.0',
            cldrStatusDefinitions: 'https://unicode.org/reports/tr35/tr35-info.html',
            headerBehavior: {
                windows: 'https://learn.microsoft.com/en-us/windows/apps/design/globalizing/manage-language-and-region',
                chrome: 'https://chromium.googlesource.com/chromium/src/+/main/net/http/http_util.cc',
                chromeReduced: 'https://developer.chrome.com/release-notes/136',
                firefox: 'coverage/browser-captures.json (Firefox 155.0; seeded intl.accept_languages preference)',
                edge: 'https://learn.microsoft.com/en-us/deployedge/microsoft-edge-policies/definepreferredlanguages',
            },
        },
        methodology: 'Country/official-language preference scenarios, not geolocation defaults. Header shapes are source-derived and representative quality weights preserve preference order. Chromium reduced cases use the first tag only as a compatibility probe; local captures demonstrate the observed default behavior separately. Windows profiles are documented models, not Windows captures. CLDR functional status is supplemented by the cited government corrections; this is not an exhaustive legal certification of every municipality.',
        speakerLimitations: 'CLDR estimates include language users rather than native speakers only; vintage varies. Script variants, aliases, multilingual users, and jurisdictions overlap. Do not sum these estimates into unique people.',
        countries: countryResults, exclusions, researchNotes, unresolvedMappings, censusEvidence, cases: profiles,
    };
}

function replayIsCurrent(audit, results, root = ROOT) {
    if (!results || results.auditSha256 !== digest(audit) || results.catalogSha256 !== audit.catalogSha256) return false;
    const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
    try {
        if (hash(readmeStatement(root)) !== results.statementSha256) return false;
        const catalog = JSON.parse(fs.readFileSync(path.join(root, 'languages.json'), 'utf8'));
        return catalog.languages.every(({ tag }) => hash(fs.readFileSync(path.join(root, 'language', `${tag}.json`))) === results.translationSha256?.[tag]);
    } catch { return false; }
}

function renderGaps(audit, results) {
    const actual = new Map((results?.cases || []).map(c => [c.id, c]));
    const groups = new Map();
    for (const row of audit.cases) {
        const observation = actual.get(row.id);
        const issues = [...row.issues];
        if (observation && observation.selectedLocale !== row.expectedLocale) issues.push('module-behavior-gap');
        if (!observation) issues.push('not-yet-tested-in-nginx');
        if (!issues.length) continue;
        const key = `${row.country}/${row.language}`;
        if (!groups.has(key)) groups.set(key, { ...row, issues: new Set(), clients: new Set(), selections: new Set() });
        const group = groups.get(key);
        issues.forEach(issue => group.issues.add(issue));
        group.clients.add(`${row.client}${row.mode === 'reduced' ? ' (reduced)' : ''}`);
        group.selections.add(observation?.selectedLocale || 'not tested');
    }
    const esc = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    const countries = new Map(audit.countries.map(c => [c.code, c.name]));
    const summary = `${audit.countries.length} countries/territories; ${new Set(audit.cases.map(c => `${c.country}/${c.language}`)).size} official language/written-form profiles; ${audit.cases.length} header cases.`;
    const lines = [
        '# Official-language coverage gaps', '', summary, '',
        results ? `Real nginx replay: ${results.cases.length} audit requests, ${results.localeRequests} direct locale requests; nginx ${results.build.nginxVersion}. Full observed selections are in [coverage/nginx-results.json](coverage/nginx-results.json).` : 'The nginx replay has not been recorded yet.', '',
        'The complete country roster, including covered entries and explicit exclusions, is in [coverage/audit.json](coverage/audit.json). Cases concern a user who prefers each official language; geography does not determine browser preferences. A response in English or another official language is not coverage of the requested language.', '',
        'CLDR 48 supplies functional official-status classifications and approximate language-user populations. Government-source additions and removals are retained in `coverage/research/*-status.json`. Protected or national-language recognition alone is not treated as official status where the reviewed law distinguishes them. Municipal-level omissions or disputed statuses may remain; this report is not a universal legal certification.', '',
        'Browser rows are source-derived scenarios, with exact local browser captures retained separately. A browser-profile-evidence gap means the reviewed published menu/pack list does not establish that preference; it does not mean the browser is incapable of sending it. Chrome reduced-header rows are compatibility probes, not claims about every installation. Windows-app weights follow the documented representative pattern.', '',
        'Speaker figures are **not additive**: languages, scripts, aliases, multilingual people, and overlapping jurisdictions can repeat the same population. CLDR counts below estimate language users, not native speakers; their underlying observation years vary. Government census figures retain their own measure and year. Unknown means no reliable figure was found, not zero.', '',
        '## Remaining cases', '',
        '| Country | Official language / form | Gap | Clients | Example header | Observed locale(s) | Speakers and source | Feasibility / review |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ];
    for (const row of groups.values()) {
        const s = row.speakers || {};
        const estimate = s.percentage != null ? `${s.percentage}% (count not derived)` : s.estimate == null ? 'Unknown' : Number(s.estimate).toLocaleString('en-US');
        const speakers = `${estimate}; ${s.kind || 'unknown measure'}; ${s.year || 'year unknown'}${s.source ? ` ([source](${s.source}))` : ''}`;
        lines.push(`| ${esc(countries.get(row.country))} (${row.country}) | ${esc(row.languageName)} \`${row.language}\` (${row.officialStatus}) | ${[...row.issues].join(', ')} | ${[...row.clients].join(', ')} | \`${esc(row.header)}\` | ${[...row.selections].join(', ')} | ${esc(speakers)} | ${esc(row.translationFeasibility)} |`);
    }
    lines.push('', '## Territory dispositions', '', '| Territory | Disposition | Evidence |', '| --- | --- | --- |');
    for (const c of audit.countries.filter(c => !c.cases)) lines.push(`| ${esc(c.name)} (${c.code}) | ${esc(c.disposition)}: ${esc(c.note || 'Official-language evidence requires review.')} | ${(c.sources || []).map(url => `[source](${url})`).join(', ')} |`);
    lines.push('', '## Unresolved legal scope and identifier mappings', '', 'These sourced research gaps remain open even where an enumerated header case passes. An unresolved umbrella is not silently represented by a related language. Speaker figures for unmapped groups are unknown and are not inferred from ethnicity.', '', '| Country / scope | Status or identifier question | Sources |', '| --- | --- | --- |');
    for (const note of [...(audit.unresolvedMappings || []), ...(audit.researchNotes || [])]) {
        lines.push(`| ${esc(note.country || note.topic || 'See source scope')} | ${esc([note.statutoryName || note.statutoryNames?.join(', '), note.reason || note.assessment].filter(Boolean).join(': '))} | ${(note.sources || []).map(url => `[source](${url})`).join(', ')} |`);
    }
    lines.push('', '## Additional census evidence', '', 'These published aggregates are retained as evidence without assigning them to narrower varieties or scripts. Counts describe the source’s measure, not necessarily native speakers.', '', '| Country | Census language group | Figure | Measure / year | Source |', '| --- | --- | --- | --- | --- |');
    for (const census of audit.censusEvidence || []) {
        for (const [label, count] of Object.entries(census.countsByCensusLabel || {})) lines.push(`| ${census.country} | ${esc(label)} | ${Number(count).toLocaleString('en-US')} | ${esc(census.kind)}; ${census.year} | [source](${census.source}) |`);
    }
    lines.push('', '## Module limitation', '', 'The tested module uses RFC 4647-style truncation and case-insensitive matching, but still processes header order and ignores quality values. Unsorted quality preferences and `q=0` exclusions therefore require separate module review. The country profiles use descending positive weights. This limitation is not a missing translation.', '');
    return lines.join('\n');
}

if (require.main === module) {
    const audit = buildAudit();
    fs.writeFileSync(path.join(ROOT, 'coverage/audit.json'), JSON.stringify(audit, null, 2) + '\n');
    const resultFile = path.join(ROOT, 'coverage/nginx-results.json');
    const results = fs.existsSync(resultFile) ? read('coverage/nginx-results.json') : null;
    fs.writeFileSync(path.join(ROOT, 'GAPS.md'), renderGaps(audit, replayIsCurrent(audit, results) ? results : null));
    console.log(`Built ${audit.cases.length} header cases across ${audit.countries.length} countries/territories.`);
}

module.exports = { buildAudit, lookup, makeHeader, preferredLocale, renderGaps, digest, replayIsCurrent };
