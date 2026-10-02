# International Language files for X4B.Net static pages

Want to see your language supported for error & challenge pages? Language files contributed to this repository will be reviewed for acceptance. 

We'd welcome any contribution! Before we can take them, we have to jump a couple of legal hurdles. You will be required to sign the CLA in your PR request. You can find detail on [the CLA here](https://github.com/X4BNet/static-page-i8n/blob/main/CLA.md)

## Language Files

Language files are UTF-8 JSON documents named with registered BCP 47 language tags, as used by `Accept-Language`, for example `en.json`, `vi.json`, and `bho.json`. These are language tags, not country codes. See [HTTP language negotiation](https://www.rfc-editor.org/rfc/rfc9110.html#name-accept-language) and the [IANA language subtag registry](https://www.iana.org/assignments/language-subtag-registry/language-subtag-registry).

[languages.json](languages.json) records the language and locale roster, English names, scripts, chosen written forms, provenance, and selection sources. The roster prioritizes public native-speaker estimates and practical written-language coverage; it is not an exact current population ranking. English is included. The original 100 languages remain supported; additions cover official languages and necessary written forms. Arabic uses Modern Standard Arabic and Chinese uses simplified standard written Chinese. Regional and script variants do not count as additional languages.

The roster includes 12 documented substitutions. Subagents could not defensibly translate Balochi, Chittagonian, Kikuyu, Kongo, Mossi, Awadhi, Magahi, Santali, Saraiki, Zhuang, Kashmiri, or Sylheti for this corpus. Under the user-approved policy of retaining 100 complete languages, the selected additions are Hebrew, Albanian, Armenian, Finnish, Danish, Slovak, Norwegian Bokmål, Catalan, Lao, Mongolian, Belarusian, and Lithuanian. The catalog records each mapping; the omitted languages are not claimed as supported.

Vietnamese has been renamed from the incorrect `vn.json` to `vi.json`. Consumers that previously selected `vn` must now select `vi`. This repository supplies translation data and a tested nginx negotiation example; consumers still provide page layout, fonts, and right-to-left rendering.

## Translation rules

[language/en.json](language/en.json) is the source of truth for meaning and structure. Each language contains all 63 text entries and all 11 boolean settings. Translate strings only; keep keys, nesting, array lengths and order, boolean values, template placeholders, HTML tags and attributes, links, and technical identifiers unchanged. In particular, preserve `{host}`, `{http_host}`, `HTTP`, `HTTPS`, `IP`, `URL`, `CAPTCHA`, `JavaScript`, and the literal `https://` prefix. Interpret grammatical mistakes in English according to their intended meaning without changing the source file.

Languages written right to left include the top-level metadata field `"direction": "rtl"`. Consumers should default files without this field to `ltr` and expose the direction on the rendered document, for example with `<html dir="rtl">`.

The expansion uses direct model translations by subagents, followed by source-based review and automated validation. Existing translations supply additional terminology context. The committed translations are not generated with Google Translate or the legacy translation utility, and are not certified by native speakers.

The catalog marks translations needing further review with `reviewPriority` and specific `reviewNotes`. These files are complete and have received source-based review, but the recorded terminology, grammar, or dialect concerns remain unresolved.

A follow-up searched translated titles and keywords for all 43 initially flagged languages and compared every entry against English again. Published software localizations, manufacturer manuals, government documents, and authored prose supported clearing 28 flags, leaving 15 with narrower concerns. [translation-usage-review.json](translation-usage-review.json) records each language's queries, source links, attested terms, corrections, decision, and reviewed-file hash. The catalog's `usageReview` field links to this evidence. Clearing a flag means its specific concern was addressed by usage evidence and model review; it is not native-speaker certification. Isolated word matches and apparent automatic multilingual pages were not sufficient evidence.

Before expanding coverage, three fresh subagents translated German, Spanish, and Vietnamese without reading their existing translations. They then compared the drafts against those references, using English to resolve disagreements. [translation-review.json](translation-review.json) records the method, findings, corrections, and limitations; the original blind drafts are preserved in [tests/fixtures/translation-benchmark](tests/fixtures/translation-benchmark).

The semantic review found the same operational meaning in 61 of 61 available German entries and 62 of 63 Spanish entries. Vietnamese had 36 acceptable equivalents and 27 meaning differences, often caused by reference wording such as “unavailable” becoming “does not exist.” Review also found four corrections in the new Vietnamese draft. These are review judgments, not accuracy scores or evidence that all other languages have equivalent quality.

## Validation

No dependency installation or translation-service access is required. With Node.js 18 or later, run from the repository root:

```sh
npm test
```

This runs validator regression tests and checks every catalogued locale file against English, including complete coverage, types, settings, placeholders, balanced HTML, attributes, technical identifiers, expected scripts, unchanged English text, and identical language files. Script detection and structural checks cannot establish fluency or semantic accuracy.

The same checks run for pull requests in CI and through `npm test` in `translate-tool/`. The legacy utility now preserves non-string settings and validates results before writing; it was not used to generate this expansion.

For just the complete-file checks:

```sh
npm run validate
```

The existing Python syntax and formatting validator also remains available:

```sh
python scripts/validate_language_files.py
```

Language updates will be reviewed before inclusion.

## nginx language negotiation

Put the complete statement below in the `http` block, once. English is the first entry and therefore the default. The sibling [nginx Accept Language module](../nginx_accept_language_module) must include its RFC 4647-style lookup update: `de-DE` can then select `de`, while an available exact locale takes precedence. The module processes preferences in header order and currently ignores quality weights; it is not a complete quality-value negotiation implementation.

<!-- nginx-language-statement:start -->

```nginx
http {
    set_from_accept_language $lang en
        af ak am ar as az be bg bho bi bn bs
        bs-cyrl ca ceb ckb cnr cnr-cyrl crs cs cy da de el
        es et eu fa fa-af ff fi fil fj fo fr fy
        ga gd gl gn gu ha haw he hi hil hmn hne
        hr ht hu hy id ig ilo is it ja jv ka
        kk km kn ko ku ku-arab ky la lb lg ln lo
        lt lv mad mai mg mi mk ml mn mr ms mt
        my nb nd ne nl nn no nso ny om or pa
        pap pl prs ps pt qu raj rn ro ru rw sa
        sco sd si sk sl sm sn so sq sr sr-latn ss
        st su sv sw ta te tet tg th ti tk tl
        tn to tpi tr ts tt ug uk ur uz vi war
        wo xh yo zh zh-hant zh-hant-hk zh-hant-mo zh-hant-tw zh-hk zh-mo zh-tw zu;
    # Your server blocks go here.
}
```

<!-- nginx-language-statement:end -->

The statement and declared same-language alias files are generated from the catalog with `npm run update:languages`. Filenames and configuration tokens use lowercase BCP 47 tags; request matching is case-insensitive. Aliases are explicit routing names for the same reviewed written form and do not count as new languages.

Run `npm run build:nginx` to build an isolated test binary from the sibling module checkout. It prints the binary path. Then run `TEST_NGINX_BINARY=/path/printed/by/build npm run test:nginx`. This checks the exact README statement with `nginx -t`, starts its own loopback server, requests every locale and every audit profile, and stops only its own process. It requires a C compiler, make, tar, PCRE2 and zlib development headers to build; the HTTP test itself uses only Node standard libraries. No running system nginx is reconfigured.

## Official-language coverage audit

[GAPS.md](GAPS.md) reports remaining translation, written-form, identifier, browser-evidence, and negotiation gaps. The reproducible audit covers the 249 ISO countries and territories plus Kosovo, including national, regional, and de facto official languages. CLDR 48 is the starting dataset; sourced government corrections distinguish official status from national-language recognition or protection. All included and excluded cases, estimates, sources, and actual nginx selections are retained under [coverage/](coverage/).

Header profiles model users who prefer each official language. They are not claims that geography fixes a browser's settings. Local browser captures are labelled with browser version and operating system; source-derived Windows and country cases are labelled separately. Selecting English or a different official language does not establish coverage of the requested language. Speaker estimates may overlap and must not be summed into a unique-person coverage figure.

Run `npm run audit:coverage` after updating evidence or translations, then run the nginx integration test to refresh observed selections and `GAPS.md`. `npm test` checks catalogue, configuration, and audit consistency without network access.
