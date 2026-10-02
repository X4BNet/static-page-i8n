#!/usr/bin/env node
'use strict';

// Preserve every source screenshot pixel; captions and gutters are additions.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.env.VISUAL_REVIEW_OUTPUT || path.join(ROOT, 'visual-review/generator-fixes'));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(output, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const directory = path.join(output, 'review-sheets');
const panels = path.join(directory, 'panels');
const env = { ...process.env, MAGICK_THREAD_LIMIT: '2' };
const images = [];

if (manifest.viewPlan) for (const [tag, planned] of Object.entries(manifest.viewPlan)) {
    const captured = manifest.locales[tag]?.screenshots || [];
    if (planned.length !== captured.length || planned.some(view => !captured.some(image => image.page === view.page && image.state === view.state))) {
        throw new Error(`Incomplete capture plan for ${tag}; finish captures before building review sheets`);
    }
}

for (const [tag, locale] of Object.entries(manifest.locales).sort(([a], [b]) => a.localeCompare(b))) {
    if (tag === 'en' || tag === 'my') continue;
    for (const view of locale.screenshots.filter(view => view.state === 'nojs').sort((a, b) => a.page.localeCompare(b.page))) {
        const actualSha256 = hash(fs.readFileSync(path.join(output, view.file)));
        if (actualSha256 !== view.sha256) throw new Error(`Screenshot hash mismatch: ${view.file}`);
        images.push({
            tag, page: view.page, state: view.state, file: view.file, sha256: actualSha256,
            translationSha256: locale.translationSha256,
        });
    }
}

fs.mkdirSync(panels, { recursive: true });
const sheets = [];
for (let start = 0; start < images.length; start += 4) {
    const members = images.slice(start, start + 4);
    const filenames = members.map(view => {
        const filename = path.join(panels, `${view.tag}--${view.page}--${view.state}.png`);
        execFileSync('magick', [path.join(output, view.file), '+repage',
            '-background', '#e5edf5', '-gravity', 'north', '-splice', '0x30',
            '-font', 'DejaVu-Sans', '-pointsize', '17', '-fill', '#111111',
            '-annotate', '+0+6', `${view.tag} / ${view.page} / ${view.state}`,
            '-define', 'png:compression-level=1', filename], { env });
        return filename;
    });
    const file = `review-sheets/sheet-${String(sheets.length + 1).padStart(3, '0')}.png`;
    const filename = path.join(output, file);
    execFileSync('magick', ['montage', ...filenames, '-tile', '2x', '-geometry', '+5+5',
        '-background', '#c7c7c7', '-define', 'png:compression-level=1', filename], { env });
    sheets.push({ file, sha256: hash(fs.readFileSync(filename)), images: members });
    console.log(`${file}: ${members.map(view => `${view.tag}/${view.page}`).join(', ')}`);
}

fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({
    schemaVersion: 1, createdAt: new Date().toISOString(),
    manifestSha256: hash(manifestBytes), sourceImageCount: images.length,
    note: 'Complete no-JavaScript screenshots at original pixel dimensions, four per sheet in two columns. English and Myanmar are reviewed separately.',
    sheets,
}, null, 2) + '\n');
