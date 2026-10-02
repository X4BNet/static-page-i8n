#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(process.env.VISUAL_REVIEW_OUTPUT || path.join(ROOT, 'visual-review/generator-fixes'));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fingerprint = file => hash(fs.readFileSync(file));
const manifest = read(path.join(OUTPUT, 'manifest.json'));
const original = read(path.join(ROOT, 'visual-review/manifest.json'));
const catalog = read(path.join(ROOT, 'languages.json'));
const plan = read(path.join(ROOT, 'coverage/generator-fixes/capture-plan.json'));
const reports = ['review-controls.json', 'review-nojs-a.json', 'review-nojs-b.json'].map(file => ({
    file: `coverage/generator-fixes/${file}`,
    data: read(path.join(ROOT, 'coverage/generator-fixes', file)),
}));
const reviewed = new Map();
for (const report of reports) {
    for (const sheet of report.data.reviewedSheets || report.data.sheetsSeen) {
        assert.equal(fingerprint(path.join(OUTPUT, sheet.file)), sheet.sha256, `Stale reviewed sheet: ${sheet.file}`);
    }
    for (const image of report.data.reviewedImages || report.data.images) {
        assert(!reviewed.has(image.file), `Duplicate primary image review: ${image.file}`);
        reviewed.set(image.file, { sha256: image.sha256, report: report.file });
    }
}
assert.deepEqual(Object.keys(plan).sort(), catalog.languages.map(locale => locale.tag).sort());
assert.deepEqual(Object.keys(manifest.locales).sort(), Object.keys(plan).sort());
assert.equal(manifest.viewPlanSha256, hash(JSON.stringify(plan)));
const counts = { locales: 0, html: 0, images: 0, nojs: 0 };
const locales = {};
for (const { tag } of catalog.languages) {
    const render = manifest.locales[tag];
    const translation = fingerprint(path.join(ROOT, 'language', `${tag}.json`));
    assert.equal(render.translationSha256, translation, `${tag}: translation changed after capture`);
    assert.equal(original.locales[tag].translationSha256, translation, `${tag}: translation changed during generator repair`);
    assert.deepEqual(render.screenshots.map(({ page, state }) => ({ page, state })), plan[tag]);
    assert.equal(render.html.length, 19);
    for (const artifact of [...render.html, ...render.screenshots]) {
        assert.equal(fingerprint(path.join(OUTPUT, artifact.file)), artifact.sha256, artifact.file);
    }
    for (const view of render.screenshots) {
        assert.equal(reviewed.get(view.file)?.sha256, view.sha256, `Unreviewed current image: ${view.file}`);
        assert.deepEqual(view.pageErrors, [], view.file);
        assert.equal(view.panelOverflow, false, view.file);
        assert.equal(view.horizontalOverflow, false, view.file);
        if (view.state === 'nojs') {
            assert.equal(view.visibleSubmitControls, 1, view.file);
            assert.equal(view.loadingMessageVisible, false, view.file);
            counts.nojs++;
        }
        if (view.state === 'loading') assert.equal(view.loadingMessageVisible, true, view.file);
    }
    locales[tag] = {
        translationSha256: translation,
        images: render.screenshots.map(({ file, sha256, page, state }) => ({ file, sha256, page, state, reviewReport: reviewed.get(file).report })),
    };
    counts.locales++;
    counts.html += render.html.length;
    counts.images += render.screenshots.length;
}
assert.equal(reviewed.size, counts.images);
const sourceFiles = ['resources/css/client.css', 'resources/css/protection.css', 'resources/html/antispam.html'];
const fixedSourceHashes = {};
for (const file of sourceFiles) {
    const expected = manifest.generator.files[file];
    assert.equal(fingerprint(path.join(ROOT, '../static-pages', file)), expected, `Generator changed after capture: ${file}`);
    fixedSourceHashes[file] = expected;
}
const panelComparison = {};
for (const tag of ['en', 'my']) {
    panelComparison[tag] = ['resource', 'resource_limitcon', 'resource_limitrate'].map(page => {
        const before = original.locales[tag].screenshots.find(view => view.page === page);
        const after = manifest.locales[tag].screenshots.find(view => view.page === page);
        return { page, beforeHeight: before.panel.height, afterHeight: after.panel.height, beforeOverflow: before.panelOverflow, afterOverflow: after.panelOverflow };
    });
}
const summary = {
    schemaVersion: 1, reviewedOn: '2026-10-02', status: 'resolved',
    scope: 'Three generator findings: duplicate no-JavaScript submit controls, font metadata/loading-state CSS collision, and Myanmar resource-panel overflow. All captured images explicitly inspected; translations unchanged.',
    counts, generator: manifest.generator, fixedSourceHashes,
    browser: manifest.browser, viewport: manifest.viewport, fonts: manifest.fonts,
    conditions: manifest.conditions, generation: manifest.generation,
    manifestSha256: fingerprint(path.join(OUTPUT, 'manifest.json')),
    capturePlanSha256: fingerprint(path.join(ROOT, 'coverage/generator-fixes/capture-plan.json')),
    gallery: 'visual-review/generator-fixes/index.html',
    panelComparison, locales,
    reports: reports.map(report => ({ file: report.file, sha256: fingerprint(path.join(ROOT, report.file)) })),
    limitations: ['Desktop Chromium captures use local CAPTCHA fixtures and recorded fonts.', 'Existing fixed horizontal error-panel width remains outside these vertical-containment fixes.', 'Original full-language review evidence remains attached to its original generator snapshot.'],
};
fs.writeFileSync(path.join(ROOT, 'coverage/generator-fixes/review.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Verified generator fixes: ${counts.locales} locales, ${counts.html} HTML files, ${counts.images} visually reviewed images, ${counts.nojs} no-JavaScript views.`);
