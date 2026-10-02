#!/usr/bin/env node
'use strict';

// Verifies recorded human/model image inspection against actual render artifacts.
// This does not infer linguistic quality or replace looking at the images.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.resolve(process.env.VISUAL_REVIEW_OUTPUT || path.join(ROOT, 'visual-review'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const catalog = read(path.join(ROOT, 'languages.json'));
const manifest = read(path.join(OUTPUT, 'manifest.json'));
const reports = fs.readdirSync(path.join(ROOT, 'coverage/visual-reviews'))
    .filter(file => file.endsWith('.json') && file !== 'assignments.json')
    .map(file => ({ file: `coverage/visual-reviews/${file}`, data: read(path.join(ROOT, 'coverage/visual-reviews', file)) }));
const summary = {
    schemaVersion: 1, reviewedOn: '2026-10-02',
    method: 'All screenshots explicitly viewed through original-resolution contact sheets, with full-image follow-up for suspicious details. Independent subagents compared translations with unchanged English. Hash checks establish artifact identity, not linguistic accuracy.',
    generator: manifest.generator, browser: manifest.browser, platform: manifest.platform,
    viewport: manifest.viewport, fonts: manifest.fonts,
    generation: manifest.generation, conditions: manifest.conditions,
    artifacts: 'visual-review/index.html (generated locally; bulk HTML and PNG files are ignored by git)',
    englishSha256: hash(fs.readFileSync(path.join(ROOT, 'language/en.json'))),
    counts: { locales: 0, html: 0, images: 0 }, locales: {},
};
for (const { tag } of catalog.languages) {
    const render = manifest.locales[tag];
    assert(render, `${tag}: render is missing`);
    const translationHash = hash(fs.readFileSync(path.join(ROOT, 'language', `${tag}.json`)));
    assert(render.translationSha256 === translationHash, `${tag}: rerender changed translation`);
    const matches = reports.filter(report => report.data.locales?.[tag]);
    assert(matches.length === 1, `${tag}: expected exactly one review report, found ${matches.length}`);
    const report = matches[0];
    const review = report.data.locales[tag];
    assert(review.translationSha256 === translationHash, `${tag}: review translation fingerprint is stale`);
    assert(review.captureVersion === render.captureVersion && review.fontFingerprint === render.fontFingerprint, `${tag}: review capture conditions are stale`);
    assert(render.html.length === 19 && render.screenshots.length === 25, `${tag}: incomplete render`);
    assert(review.images.length === render.screenshots.length && new Set(review.images.map(image => image.file)).size === 25, `${tag}: incomplete image review`);
    assert(review.sheetsSeen.length === 4 && new Set(review.sheetsSeen.map(sheet => sheet.file)).size === 4, `${tag}: incomplete contact sheet review`);
    const sheetIndex = read(path.join(OUTPUT, 'sheets', tag, 'index.json'));
    assert(sheetIndex.translationSha256 === translationHash, `${tag}: contact sheets use a stale translation`);
    const sheetImages = sheetIndex.sheets.flatMap(sheet => sheet.images);
    assert(sheetImages.length === 25 && new Set(sheetImages.map(image => image.file)).size === 25, `${tag}: contact sheets do not contain all image states`);
    for (const artifact of [...render.html, ...render.screenshots]) {
        assert(hash(fs.readFileSync(path.join(OUTPUT, artifact.file))) === artifact.sha256, `${artifact.file}: artifact fingerprint changed`);
    }
    for (const image of render.screenshots) {
        assert(review.images.some(seen => seen.file === image.file && seen.sha256 === image.sha256), `${image.file}: current screenshot has not been reviewed`);
        assert(sheetImages.some(seen => seen.file === image.file && seen.sha256 === image.sha256), `${image.file}: contact sheet contains a stale screenshot`);
    }
    for (const sheet of review.sheetsSeen) {
        assert(sheetIndex.sheets.some(current => current.file === sheet.file), `${sheet.file}: sheet does not belong to this locale`);
        assert(hash(fs.readFileSync(path.join(OUTPUT, sheet.file))) === sheet.sha256, `${sheet.file}: reviewed sheet fingerprint changed`);
    }
    summary.locales[tag] = {
        translationSha256: translationHash, captureVersion: render.captureVersion,
        fontFingerprint: render.fontFingerprint, reviewReport: report.file,
        html: render.html, images: render.screenshots.length,
        findings: review.findings, corrections: review.corrections,
        diagnostics: render.screenshots.filter(image => image.horizontalOverflow || image.panelOverflow || image.pageErrors.length)
            .map(image => ({ file: image.file, horizontalOverflow: image.horizontalOverflow, panelOverflow: image.panelOverflow, pageErrors: image.pageErrors })),
    };
    summary.counts.locales++;
    summary.counts.html += render.html.length;
    summary.counts.images += render.screenshots.length;
}
summary.reviewReportSha256 = Object.fromEntries(reports.map(report => [report.file, hash(fs.readFileSync(path.join(ROOT, report.file)))]));
fs.writeFileSync(path.join(ROOT, 'coverage/visual-review.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`Verified ${summary.counts.locales} locale reviews, ${summary.counts.html} HTML files and ${summary.counts.images} viewed screenshots.`);
