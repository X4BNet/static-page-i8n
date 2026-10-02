#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { validTag, statistics, checkReadme } = require('./language-catalog');

const ROOT = path.resolve(__dirname, '..');
const PLACEHOLDERS = /\{+[^{}]*\}+/gu;
const HTML = /<\/?[A-Za-z][^<>]*>/gu;
const IDENTIFIERS = /HTTPS|HTTP|CAPTCHA|JavaScript|IP|URL|https?:\/\//gu;

function tokens(text, expression) {
    return [...text.matchAll(expression)].map(match => match[0]).sort();
}

function sameTokens(a, b, expression) {
    return JSON.stringify(tokens(a, expression)) === JSON.stringify(tokens(b, expression));
}

function balancedHTML(text) {
    const stack = [];
    for (const [tag] of text.matchAll(HTML)) {
        const name = tag.match(/^<\/?([A-Za-z][\w:-]*)/u)[1];
        if (tag.startsWith('</')) {
            if (stack.pop() !== name) return false;
        } else if (!tag.endsWith('/>') && !/^(?:br|hr|img|input|meta|link)$/u.test(name)) {
            stack.push(name);
        }
    }
    return stack.length === 0;
}

/** English supplies both the complete schema and immutable formatting tokens. */
function validateTranslation(candidate, reference, key = '') {
    const location = key || '<root>';
    const errors = [];
    if (Array.isArray(reference)) {
        if (!Array.isArray(candidate)) return [`${location}: expected an array`];
        if (candidate.length !== reference.length) {
            errors.push(`${location}: expected ${reference.length} array entries, got ${candidate.length}`);
        }
        reference.forEach((value, index) => {
            if (index < candidate.length) {
                errors.push(...validateTranslation(candidate[index], value, `${key}[${index}]`));
            }
        });
    } else if (reference !== null && typeof reference === 'object') {
        if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
            return [`${location}: expected an object`];
        }
        for (const child of Object.keys(reference)) {
            const childPath = key ? `${key}.${child}` : child;
            if (!Object.hasOwn(candidate, child)) errors.push(`${childPath}: missing key`);
            else errors.push(...validateTranslation(candidate[child], reference[child], childPath));
        }
        for (const child of Object.keys(candidate)) {
            if (!Object.hasOwn(reference, child)) errors.push(`${location}: unexpected key ${child}`);
        }
    } else if (typeof reference === 'string') {
        if (typeof candidate !== 'string') return [`${location}: expected a string`];
        if (!candidate.trim()) errors.push(`${location}: empty translation`);
        if (!sameTokens(candidate, reference, PLACEHOLDERS)) {
            errors.push(`${location}: template placeholders must match English exactly`);
        }
        if (!sameTokens(candidate, reference, HTML)) {
            errors.push(`${location}: HTML tags and attributes must match English exactly`);
        }
        if (!balancedHTML(candidate)) errors.push(`${location}: unbalanced HTML`);
        if (!sameTokens(candidate, reference, IDENTIFIERS)) {
            errors.push(`${location}: technical identifiers and protocol strings must match English exactly`);
        }
    } else if (candidate !== reference) {
        errors.push(`${location}: setting must remain ${JSON.stringify(reference)}`);
    }
    return errors;
}

function strings(value, key = '') {
    if (typeof value === 'string') return [[key, value]];
    if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${key}[${index}]`));
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([child, item]) => strings(item, key ? `${key}.${child}` : child));
    }
    return [];
}

function readJSON(filename) {
    // Buffer.toString silently replaces malformed UTF-8, hiding damaged translations.
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(filename)));
}

function languageData(value) {
    const { direction = 'ltr', ...translation } = value;
    return { direction, translation };
}

function validateRepository(root = ROOT) {
    const errors = [];
    const catalog = readJSON(path.join(root, 'languages.json'));
    const directory = path.join(root, 'language');
    const reference = languageData(readJSON(path.join(directory, 'en.json'))).translation;
    const tags = catalog.languages.map(language => language.tag);
    if (new Set(tags).size !== tags.length) {
        errors.push('Catalog must contain distinct locale tags');
    }
    if (statistics(catalog).languages < 100) errors.push('Catalog must retain at least 100 language identities');
    for (const tag of catalog.baselineTags || []) if (!tags.includes(tag)) errors.push(`Missing original language: ${tag}`);
    if (!tags.includes('en')) errors.push('Catalog must include the English source');
    if (catalog.nginxDocumentation) errors.push(...checkReadme(catalog, root));
    const actual = fs.readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    const expected = tags.map(tag => `${tag}.json`).sort();
    for (const filename of expected) if (!actual.includes(filename)) errors.push(`Missing language/${filename}`);
    for (const filename of actual) if (!expected.includes(filename)) errors.push(`Unexpected language/${filename}`);
    const englishStrings = new Map(strings(reference));
    const fingerprints = new Map();
    const byTag = new Map(catalog.languages.map(language => [language.tag, language]));
    for (const language of catalog.languages) {
        const { tag } = language;
        if (!validTag(tag)) {
            errors.push(`Invalid or unregistered lowercase BCP 47 locale tag: ${tag}`);
            continue;
        }
        if (language.languageId && !validTag(language.languageId)) errors.push(`${tag}: invalid language identity`);
        const filename = path.join(directory, `${tag}.json`);
        if (!fs.existsSync(filename)) continue;
        try {
            const { direction, translation } = languageData(readJSON(filename));
            if (!['ltr', 'rtl'].includes(direction)) {
                errors.push(`${tag}: direction must be either ltr or rtl`);
            }
            errors.push(...validateTranslation(translation, reference).map(error => `${tag}: ${error}`));
            const entries = strings(translation);
            let canonical = tag;
            if (language.aliasOf) {
                const target = byTag.get(language.aliasOf);
                if (!target || target.aliasOf || target.tag === tag) {
                    errors.push(`${tag}: alias must refer directly to a non-alias locale`);
                } else if ((language.languageId || tag) !== (target.languageId || target.tag) || language.script !== target.script || language.scriptCode !== target.scriptCode) {
                    errors.push(`${tag}: alias must have the same language identity and script as its target`);
                } else {
                    canonical = target.tag;
                    const targetData = languageData(readJSON(path.join(directory, `${target.tag}.json`)));
                    if (direction !== targetData.direction || JSON.stringify(translation) !== JSON.stringify(targetData.translation)) {
                        errors.push(`${tag}: alias content differs from ${target.tag}`);
                    }
                }
            }
            if (tag !== 'en') {
                for (const [key, text] of entries) {
                    if (text === englishStrings.get(key) && !(language.unchangedEnglishKeys || []).includes(key)) {
                        errors.push(`${tag}: ${key}: unchanged English text needs review`);
                    }
                }
                if (language.script) {
                    const script = new RegExp(`\\p{Script=${language.script}}`, 'u');
                    const prose = entries.map(([, text]) => text.replace(HTML, '').replace(PLACEHOLDERS, '').replace(IDENTIFIERS, '')).join(' ');
                    if (!script.test(prose)) errors.push(`${tag}: expected ${language.script} script`);
                }
            }
            const fingerprint = JSON.stringify([...entries].sort(([a], [b]) => a.localeCompare(b)));
            if (fingerprints.has(fingerprint) && fingerprints.get(fingerprint).canonical !== canonical) {
                errors.push(`${tag}: identical to ${fingerprints.get(fingerprint).tag} without a declared alias`);
            }
            fingerprints.set(fingerprint, { tag, canonical });
        } catch (error) {
            errors.push(`${tag}: ${error.message}`);
        }
    }
    return errors;
}

if (require.main === module) {
    try {
        const errors = validateRepository();
        if (errors.length) {
            console.error(errors.join('\n'));
            process.exitCode = 1;
        } else {
            const counts = statistics(readJSON(path.join(ROOT, 'languages.json')));
            console.log(`Validated ${counts.files} locale files (${counts.languages} language identities, ${counts.aliases} aliases) against English.`);
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { validateTranslation, validateRepository, readJSON, strings };
