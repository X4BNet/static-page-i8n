#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const output = path.resolve(process.env.VISUAL_REVIEW_OUTPUT || path.join(ROOT, 'visual-review'));
const manifest = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
const filter = process.argv.find(arg => arg.startsWith('--locales='))?.slice('--locales='.length).split(',');
const rows = {};
for (const [tag, record] of Object.entries(manifest.locales)) {
    if (filter && !filter.includes(tag)) continue;
    const directory = path.join(output, 'sheets', tag);
    const panels = path.join(directory, 'panels');
    fs.mkdirSync(panels, { recursive: true });
    const groups = [record.screenshots.filter(view => view.panel), record.screenshots.filter(view => !view.panel)];
    let index = 0;
    rows[tag] = [];
    for (const group of groups) {
        const size = group[0]?.panel ? 9 : 4;
        for (let start = 0; start < group.length; start += size) {
            const members = group.slice(start, start + size);
            const images = [];
            for (const view of members) {
                const filename = path.join(panels, `${view.page}--${view.state}.png`);
                const args = [path.join(output, view.file)];
                if (view.panel) {
                    const boxes = [view.panel, ...view.textBoxes.filter(box => box.text)];
                    const x = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.x)) - 12));
                    const y = Math.max(0, Math.floor(Math.min(...boxes.map(box => box.y)) - 12));
                    const right = Math.ceil(Math.max(...boxes.map(box => box.x + box.width)) + 12);
                    const bottom = Math.ceil(Math.max(...boxes.map(box => box.y + box.height)) + 12);
                    args.push('-crop', `${right - x}x${bottom - y}+${x}+${y}`, '+repage');
                } else {
                    // Keep the entire challenge image, including no-JS content.
                    args.push('+repage');
                }
                args.push('-background', '#e5edf5', '-gravity', 'north', '-splice', '0x30', '-font', 'DejaVu-Sans', '-pointsize', '17', '-fill', '#111111', '-annotate', '+0+6', `${tag} / ${view.page} / ${view.state}`, '-define', 'png:compression-level=1', filename);
                execFileSync('magick', args, { env: { ...process.env, MAGICK_THREAD_LIMIT: '2' } });
                images.push(filename);
            }
            const file = `sheets/${tag}/sheet-${++index}.png`;
            execFileSync('magick', ['montage', ...images, '-tile', '2x', '-geometry', '+5+5', '-background', '#c7c7c7', '-define', 'png:compression-level=1', path.join(output, file)], { env: { ...process.env, MAGICK_THREAD_LIMIT: '2' } });
            rows[tag].push({ file, images: members.map(view => ({ file: view.file, sha256: view.sha256 })) });
        }
    }
    fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({ tag, translationSha256: record.translationSha256, sheets: rows[tag] }, null, 2) + '\n');
    console.log(`${tag}: ${index} sheets containing all ${record.screenshots.length} images`);
}
