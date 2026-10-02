#!/usr/bin/env node
'use strict';

// Evidence verification is deliberately separate from linguistic judgment.
// Requires the ignored input snapshot and images described in the review README.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { validateTranslation } = require('./validate-language-files');
const ROOT = path.resolve(__dirname, '..');
const DIRECTORY = path.join(ROOT, 'coverage/linguistic-review');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const get = (object, keys) => keys.reduce((value, key) => value[key], object);
const keyId = keys => JSON.stringify(keys);
const plan = read(path.join(DIRECTORY, 'plan.json'));
const review = read(path.join(DIRECTORY, 'review.json'));
const catalog = read(path.join(ROOT, 'languages.json'));
const reference = read(path.join(ROOT, 'language/en.json'));
const output = path.resolve(ROOT, review.visual.output);
assert.equal(review.status, 'complete-with-documented-uncertainty');
assert.equal(hash(path.join(DIRECTORY, 'plan.json')), review.planSha256);
assert.equal(hash(path.join(ROOT, 'languages.json')), review.catalogSha256);
assert.equal(hash(path.join(ROOT, 'language/en.json')), plan.englishSha256);
const checked = record => {
    const file = path.join(ROOT, record.file);
    assert.equal(hash(file), record.sha256, `Changed evidence: ${record.file}`);
    return read(file);
};
const primary = new Map(review.primaryReports.map(record => [record.group, checked(record)]));
const adjudications = new Map(review.adjudicationReports.map(record => [record.group, checked(record)]));
function stringKeys(value, keys = []) {
    if (typeof value === 'string') return [keys];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => stringKeys(child, [...keys, Array.isArray(value) ? Number(key) : key]));
}
const allKeys = stringKeys(reference).map(keyId).sort();
assert.equal(allKeys.length, 63);
let inspectedStrings = 0;
const tags = [];
for (const [group, assignment] of Object.entries(plan.assignments)) {
    const report = primary.get(group);
    const second = adjudications.get(group);
    assert(report && second, `Missing review group: ${group}`);
    assert.notEqual(report.reviewer, second.reviewer, `Self-adjudication: ${group}`);
    assert.deepEqual(Object.keys(report.profiles).sort(), [...assignment.fullReview, ...assignment.focusedReview].sort());
    for (const [tag, profile] of Object.entries(report.profiles)) {
        assert.equal(profile.inputSha256, plan.initialTranslationSha256[tag], tag);
        const keys = profile.inspectedKeys.map(keyId);
        assert.equal(new Set(keys).size, keys.length, `Repeated review key: ${tag}`);
        for (const key of profile.inspectedKeys) assert.equal(typeof get(reference, key), 'string', `${tag}/${key}`);
        if (assignment.fullReview.includes(tag)) assert.deepEqual([...keys].sort(), allKeys, `Incomplete full review: ${tag}`);
        for (const key of [['challenge', 'enable_javascript'], ['error', 'timeout', 'description'], ['error', 'unsupported_method', 'description']]) {
            assert(keys.includes(keyId(key)), `Missing focus: ${tag}/${key}`);
        }
        tags.push(tag);
        inspectedStrings += keys.length;
        for (const proposal of profile.proposedCorrections) {
            const decisions = second.decisions.filter(item => item.tag === tag && keyId(item.key) === keyId(proposal.key));
            assert.equal(decisions.length, 1, `Missing/duplicate adjudication: ${tag}/${proposal.key}`);
            const decision = decisions[0];
            assert.equal(decision.before, proposal.before);
            assert.equal(decision.after, proposal.after);
            const applied = review.changes.filter(item => item.tag === tag && keyId(item.key) === keyId(proposal.key));
            assert.equal(applied.length, decision.decision === 'accept' ? 1 : 0, `Adjudication not reflected: ${tag}/${proposal.key}`);
        }
    }
}
assert.equal(tags.length, new Set(tags).size);
assert.deepEqual(tags.sort(), [...plan.flaggedCanonicalProfiles, ...plan.additionalVisualProfiles].sort());
for (const tag of plan.flaggedCanonicalProfiles) {
    const locale = catalog.languages.find(item => item.tag === tag);
    if (review.clearedFlags.includes(tag)) {
        assert(!locale.reviewPriority, `Cleared flag still present: ${tag}`);
        const group = Object.keys(plan.assignments).find(name => plan.assignments[name].fullReview.includes(tag));
        assert.equal(primary.get(group).profiles[tag].recommendedDisposition, 'clear-flag');
        assert.equal(adjudications.get(group).flagDecisions[tag].decision, 'accept');
    } else assert(locale.reviewPriority, `Unapproved flag clearance: ${tag}`);
}
const changes = new Map();
for (const change of review.changes) {
    const report = primary.get(change.group);
    const proposal = report.profiles[change.tag].proposedCorrections.find(item => keyId(item.key) === keyId(change.key));
    assert(proposal, `Unproposed edit: ${change.tag}/${change.key}`);
    assert.equal(change.before, proposal.before);
    assert.equal(change.after, proposal.after);
    assert.equal(get(reference, change.key), proposal.english);
    if (!changes.has(change.tag)) changes.set(change.tag, []);
    changes.get(change.tag).push(change);
}
assert.deepEqual(Object.keys(plan.initialTranslationSha256).sort(), catalog.languages.map(locale => locale.tag).sort());
for (const locale of catalog.languages) {
    const { tag } = locale;
    const initialFile = path.join(output, 'input', `${tag}.json`);
    assert.equal(hash(initialFile), plan.initialTranslationSha256[tag], `Initial snapshot changed: ${tag}`);
    const expected = read(initialFile);
    for (const change of changes.get(tag) || []) {
        assert.equal(get(expected, change.key), change.before, `${tag}/${change.key}`);
        get(expected, change.key.slice(0, -1))[change.key.at(-1)] = change.after;
    }
    const currentFile = path.join(ROOT, 'language', `${tag}.json`);
    const current = read(currentFile);
    assert.equal(hash(currentFile), review.translationSha256[tag], `Translation changed: ${tag}`);
    const target = locale.aliasOf ? read(path.join(ROOT, 'language', `${locale.aliasOf}.json`)) : expected;
    assert.deepEqual(current, target, `Unreviewed translation edit: ${tag}`);
    assert.deepEqual(Object.fromEntries(Object.entries(current).filter(([key]) => ['direction', 'fontClass'].includes(key))), plan.initialMetadata[tag], `Metadata changed: ${tag}`);
    assert.deepEqual(validateTranslation(current, reference), [], tag);
}
const manifestFile = path.join(output, 'manifest.json');
assert.equal(hash(manifestFile), review.visual.manifestSha256);
const manifest = read(manifestFile);
const capturePlan = checked(review.visual.capturePlan);
assert.deepEqual(Object.keys(manifest.locales).sort(), Object.keys(capturePlan).sort());
const seen = new Map();
for (const record of review.visual.reports) {
    const report = checked(record);
    assert.equal(report.allImagesActuallyViewed, true, record.file);
    for (const sheet of report.sheetsSeen) assert.equal(hash(path.join(output, sheet.file)), sheet.sha256, sheet.file);
    for (const image of report.images) {
        assert(!seen.has(image.file), `Duplicate image review: ${image.file}`);
        seen.set(image.file, image.sha256);
    }
}
let images = 0;
for (const [tag, record] of Object.entries(manifest.locales)) {
    assert.equal(record.translationSha256, review.translationSha256[tag], tag);
    assert.equal(record.html.length, 19);
    assert.deepEqual(record.screenshots.map(({ page, state }) => ({ page, state })), capturePlan[tag]);
    for (const artifact of [...record.html, ...record.screenshots]) assert.equal(hash(path.join(output, artifact.file)), artifact.sha256, artifact.file);
    for (const image of record.screenshots) {
        assert.equal(seen.get(image.file), image.sha256, `Unreviewed image: ${image.file}`);
        assert.deepEqual(image.pageErrors, [], image.file);
        assert.equal(image.panelOverflow, false, image.file);
        assert.equal(image.horizontalOverflow, false, image.file);
        if (image.state === 'nojs') {
            assert.equal(image.visibleSubmitControls, 1, image.file);
            assert.equal(image.loadingMessageVisible, false, image.file);
        }
        images++;
    }
}
assert.equal(images, seen.size);
for (const tag of changes.keys()) assert(manifest.locales[tag], `Changed locale not captured: ${tag}`);
for (const change of review.changes) {
    const required = change.key[0] === 'challenge'
        ? [{ page: 'challenge', state: 'nojs' }, { page: 'antispam', state: 'nojs' }]
        : [{ page: change.key[1], state: 'default' }];
    for (const view of required) assert(capturePlan[change.tag].some(item => item.page === view.page && item.state === view.state), `Changed wording not captured: ${change.tag}/${change.key}`);
}
assert(manifest.locales.en, 'English visual reference missing');
console.log(`Verified linguistic review: ${tags.length} profiles, ${inspectedStrings} inspected strings, ${review.changes.length} approved edits, ${images} visually reviewed screenshots.`);
