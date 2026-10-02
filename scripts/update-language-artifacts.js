#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { nginxStatement } = require('./language-catalog');
const root = path.resolve(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'languages.json')));
for (const language of catalog.languages.filter(l => l.aliasOf)) {
    const target = catalog.languages.find(l => l.tag === language.aliasOf);
    if (!target || target.aliasOf) throw new Error(`Invalid alias target: ${language.tag}`);
    fs.copyFileSync(path.join(root, 'language', `${target.tag}.json`), path.join(root, 'language', `${language.tag}.json`));
}
const filename = path.join(root, 'README.md');
const readme = fs.readFileSync(filename, 'utf8');
const block = `<!-- nginx-language-statement:start -->\n\n\`\`\`nginx\nhttp {\n${nginxStatement(catalog).split('\n').map(line => `    ${line}`).join('\n')}\n    # Your server blocks go here.\n}\n\`\`\`\n\n<!-- nginx-language-statement:end -->`;
const marker = /<!-- nginx-language-statement:start -->[\s\S]*?<!-- nginx-language-statement:end -->/u;
if (!marker.test(readme)) throw new Error('README nginx statement markers are missing');
fs.writeFileSync(filename, readme.replace(marker, block));
