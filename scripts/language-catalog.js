'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
let registry;

function registeredSubtags() {
    if (registry) return registry;
    registry = { language: new Set(), script: new Set(), region: new Set() };
    const text = fs.readFileSync(path.join(ROOT, 'coverage/sources/language-subtag-registry.txt'), 'utf8');
    for (const record of text.split('%%')) {
        const type = record.match(/^Type: (\S+)/mu)?.[1];
        const subtag = record.match(/^Subtag: (\S+)/mu)?.[1];
        if (registry[type] && subtag) registry[type].add(subtag.toLowerCase());
    }
    return registry;
}

function validTag(tag) {
    if (typeof tag !== 'string' || tag !== tag.toLowerCase()) return false;
    const parts = tag.split('-');
    const registered = registeredSubtags();
    if (!registered.language.has(parts.shift())) return false;
    if (parts.length && /^[a-z]{4}$/u.test(parts[0]) && !registered.script.has(parts.shift())) return false;
    if (parts.length && /^(?:[a-z]{2}|[0-9]{3})$/u.test(parts[0]) && !registered.region.has(parts.shift())) return false;
    return parts.length === 0;
}

function statistics(catalog) {
    return {
        files: catalog.languages.length,
        languages: new Set(catalog.languages.map(l => l.languageId || l.tag)).size,
        aliases: catalog.languages.filter(l => l.aliasOf).length,
    };
}

function nginxStatement(catalog) {
    const tags = catalog.languages.map(l => l.tag).filter(tag => tag !== 'en').sort();
    const lines = [];
    for (let i = 0; i < tags.length; i += 12) lines.push(`    ${tags.slice(i, i + 12).join(' ')}`);
    return `set_from_accept_language $lang en\n${lines.join('\n')};`;
}

function readmeStatement(root = ROOT) {
    const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
    const statements = readme.match(/set_from_accept_language\s+\$lang\s+[^;]+;/gu) || [];
    if (statements.length !== 1) throw new Error('README must contain exactly one complete set_from_accept_language $lang statement');
    return statements[0];
}

function checkReadme(catalog, root = ROOT) {
    try {
        const actual = readmeStatement(root).replace(/\s+/gu, ' ').trim();
        const expected = nginxStatement(catalog).replace(/\s+/gu, ' ').trim();
        return actual === expected ? [] : ['README nginx statement differs from the catalog; run npm run update:languages'];
    } catch (error) { return [error.message]; }
}

module.exports = { validTag, statistics, nginxStatement, readmeStatement, checkReadme };
