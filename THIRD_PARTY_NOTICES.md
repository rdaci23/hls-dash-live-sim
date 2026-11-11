# Third-party notices

This inventory covers all 218 locked npm dependency entries, including
development tools. Project-owned code, documentation and generated fixtures use
the [MIT License](LICENSE); dependencies and external tools retain their own terms.
Versions, integrity values, scope, provenance and notice hashes are recorded in
[the machine-readable inventory](third-party/npm-manifest.json).

The files below preserve published license/NOTICE texts verbatim. Cookie-signature
and isarray supply their full MIT terms in README license sections. The runtime
package `@nodable/entities@3.1.0` omits its license file from npm; its MIT text is
retained from the exact Git commit identified by npm's gitHead.

The development-only `require-relative@0.8.7` declares MIT and names its author,
but supplies no full license or copyright notice in its npm archive or upstream
repository. Its published declaration is retained, with the canonical SPDX MIT
template as an explicitly labelled reference. The template placeholders are not
an invented upstream copyright notice or a replacement for maintainer review.
No require-relative implementation is bundled in this project's package archive.

## External tools and media

DASH starts the upstream livesim2 v1.15.3 Docker image pinned in the adapter; this
project's npm archive does not embed or redistribute that image, its Alpine base,
Go dependencies, or upstream sample media. The [upstream engine license](third-party/sources/livesim2-v1.15.3-LICENSE.md)
is preserved for attribution. Redistribution of the image or an appliance needs
a separate inventory of its contents and notices.

HLS MP4 VoD mode starts `nytimes/nginx-vod-module`, a public build of Kaltura's
AGPL-3.0 nginx-vod-module, pinned by digest in the HLS runner. This project's
archive holds only its own nginx configuration for that image; the image is not
embedded or redistributed.

FFmpeg/libx264 are optional external fixture-generation tools; neither binaries
nor libraries are bundled. The current media uses procedural patterns and a
synthesized tone; [provenance and historical limits](assets/README.md). Browser
checks use separately installed Chrome and pinned hls.js/dash.js development
packages; Chrome binaries are not bundled.

## Locked npm dependencies

| Package | Scope | Declared license | Preserved notice/evidence |
| --- | --- | --- | --- |
| `@nodable/entities@3.1.0` | runtime | `MIT` | [nodable-entities-3.1.0-LICENSE.txt](third-party/sources/nodable-entities-3.1.0-LICENSE.txt) |
| `@nodelib/fs.scandir@2.1.5` | development | `MIT` | [LICENSE.txt](third-party/licenses/_nodelib_fs.scandir-2.1.5-0e50d0f4/LICENSE.txt) |
| `@nodelib/fs.stat@2.0.5` | development | `MIT` | [LICENSE.txt](third-party/licenses/_nodelib_fs.stat-2.0.5-a603fa29/LICENSE.txt) |
| `@nodelib/fs.walk@1.2.8` | development | `MIT` | [LICENSE.txt](third-party/licenses/_nodelib_fs.walk-1.2.8-798078f4/LICENSE.txt) |
| `@rokucommunity/bslib@0.1.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/_rokucommunity_bslib-0.1.1-2138ae87/LICENSE.txt) |
| `@rokucommunity/logger@0.4.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/_rokucommunity_logger-0.4.2-96bdafae/LICENSE.txt) |
| `chalk@4.1.2` | development | `MIT` | [license.txt](third-party/licenses/chalk-4.1.2-2089a6b1/license.txt) |
| `has-flag@4.0.0` | development | `MIT` | [license.txt](third-party/licenses/has-flag-4.0.0-66cbfa67/license.txt) |
| `supports-color@7.2.0` | development | `MIT` | [license.txt](third-party/licenses/supports-color-7.2.0-e7b7b08c/license.txt) |
| `@svta/cml-608@1.0.2` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-608-1.0.2-529854db/LICENSE.txt) |
| `@svta/cml-cmcd@2.3.2` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-cmcd-2.3.2-7b5494d5/LICENSE.txt) |
| `@svta/cml-cmsd@1.0.6` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-cmsd-1.0.6-29dcebdd/LICENSE.txt) |
| `@svta/cml-cta@1.0.6` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-cta-1.0.6-38d55024/LICENSE.txt) |
| `@svta/cml-dash@1.0.6` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-dash-1.0.6-11af7f71/LICENSE.txt) |
| `@svta/cml-id3@1.0.6` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-id3-1.0.6-e6c89553/LICENSE.txt) |
| `@svta/cml-request@1.0.12` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-request-1.0.12-de2f57c2/LICENSE.txt) |
| `@svta/cml-structured-field-values@1.1.3` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-structured-field-values-1.1.3-399be962/LICENSE.txt) |
| `@svta/cml-utils@1.5.0` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-utils-1.5.0-3ade538d/LICENSE.txt) |
| `@svta/cml-xml@1.1.4` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_svta_cml-xml-1.1.4-e7e4e19d/LICENSE.txt) |
| `@types/body-parser@1.19.6` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_body-parser-1.19.6-0c3d30fb/LICENSE.txt) |
| `@types/connect@3.4.38` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_connect-3.4.38-2e998528/LICENSE.txt) |
| `@types/express@4.17.25` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_express-4.17.25-0d22e75e/LICENSE.txt) |
| `@types/express-serve-static-core@4.19.9` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_express-serve-static-core-4.19.9-5b728e3b/LICENSE.txt) |
| `@types/http-errors@2.0.5` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_http-errors-2.0.5-7e0c4ef1/LICENSE.txt) |
| `@types/mime@1.3.5` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_mime-1.3.5-251fa018/LICENSE.txt) |
| `@types/node@24.19.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_node-24.19.2-abcdd38c/LICENSE.txt) |
| `@types/qs@6.15.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_qs-6.15.1-5519d596/LICENSE.txt) |
| `@types/range-parser@1.2.7` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_range-parser-1.2.7-6fbdd79c/LICENSE.txt) |
| `@types/send@1.2.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_send-1.2.1-9b5b2bda/LICENSE.txt) |
| `@types/serve-static@1.15.10` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_serve-static-1.15.10-9956a8e9/LICENSE.txt) |
| `@types/send@0.17.6` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_send-0.17.6-3057b924/LICENSE.txt) |
| `@types/yargs@17.0.35` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_yargs-17.0.35-14a6cf8c/LICENSE.txt) |
| `@types/yargs-parser@21.0.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/_types_yargs-parser-21.0.3-c959bdd0/LICENSE.txt) |
| `@xml-tools/parser@1.0.12` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/_xml-tools_parser-1.0.12-3c6e48cb/LICENSE.txt) |
| `chevrotain@7.1.1` | development | `Apache-2.0` | [LICENSE.txt.txt](third-party/licenses/chevrotain-7.1.1-bc68a4c8/LICENSE.txt.txt) |
| `accepts@1.3.8` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/accepts-1.3.8-818cd6a4/LICENSE.txt) |
| `ansi-regex@5.0.1` | runtime | `MIT` | [license.txt](third-party/licenses/ansi-regex-5.0.1-a9b9a5c3/license.txt) |
| `ansi-styles@4.3.0` | runtime | `MIT` | [license.txt](third-party/licenses/ansi-styles-4.3.0-9d675b59/license.txt) |
| `anymatch@3.1.3` | development | `ISC` | [LICENSE.txt](third-party/licenses/anymatch-3.1.3-e35cc372/LICENSE.txt) |
| `anynum@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/anynum-1.0.1-01ef2b73/LICENSE.txt) |
| `array-flatten@1.1.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/array-flatten-1.1.1-f844b29a/LICENSE.txt) |
| `bcp-47-match@2.0.3` | development | `MIT` | [license.txt](third-party/licenses/bcp-47-match-2.0.3-a53e9924/license.txt) |
| `binary-extensions@2.3.0` | development | `MIT` | [license.txt](third-party/licenses/binary-extensions-2.3.0-a21e4264/license.txt) |
| `body-parser@1.20.9` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/body-parser-1.20.9-9bd71de9/LICENSE.txt) |
| `braces@3.0.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/braces-3.0.3-d4939b6e/LICENSE.txt) |
| `brighterscript@0.73.8` | development | `MIT` | [LICENSE.txt](third-party/licenses/brighterscript-0.73.8-21492c87/LICENSE.txt) |
| `cliui@7.0.4` | development | `ISC` | [LICENSE.txt.txt](third-party/licenses/cliui-7.0.4-78207fb7/LICENSE.txt.txt) |
| `yargs@16.2.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/yargs-16.2.2-e3b0a2c1/LICENSE.txt) |
| `yargs-parser@20.2.9` | development | `ISC` | [LICENSE.txt.txt](third-party/licenses/yargs-parser-20.2.9-12be1625/LICENSE.txt.txt) |
| `bytes@3.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/bytes-3.1.2-d60157a9/LICENSE.txt) |
| `call-bind-apply-helpers@1.0.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/call-bind-apply-helpers-1.0.2-cbf8af04/LICENSE.txt) |
| `call-bound@1.0.4` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/call-bound-1.0.4-0c39f76d/LICENSE.txt) |
| `chalk@2.4.2` | development | `MIT` | [license.txt](third-party/licenses/chalk-2.4.2-e96ac6a5/license.txt) |
| `ansi-styles@3.2.1` | development | `MIT` | [license.txt](third-party/licenses/ansi-styles-3.2.1-6187132f/license.txt) |
| `color-convert@1.9.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/color-convert-1.9.3-1e8f7088/LICENSE.txt) |
| `color-name@1.1.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/color-name-1.1.3-117fb5e5/LICENSE.txt) |
| `chevrotain@7.1.2` | development | `Apache-2.0` | [LICENSE.txt.txt](third-party/licenses/chevrotain-7.1.2-ef1edf57/LICENSE.txt.txt) |
| `chokidar@3.6.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/chokidar-3.6.0-0040f388/LICENSE.txt) |
| `cliui@8.0.1` | runtime | `ISC` | [LICENSE.txt.txt](third-party/licenses/cliui-8.0.1-50f48f26/LICENSE.txt.txt) |
| `codem-isoboxer@0.3.10` | development | `MIT` | [LICENSE.txt.txt](third-party/licenses/codem-isoboxer-0.3.10-fb18fd89/LICENSE.txt.txt) |
| `color-convert@2.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/color-convert-2.0.1-a87fe2c0/LICENSE.txt) |
| `color-name@1.1.4` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/color-name-1.1.4-44cf8c9e/LICENSE.txt) |
| `content-disposition@0.5.4` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/content-disposition-0.5.4-06357460/LICENSE.txt) |
| `content-type@1.0.5` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/content-type-1.0.5-2e628902/LICENSE.txt) |
| `cookie@0.7.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/cookie-0.7.2-58f3dc27/LICENSE.txt) |
| `cookie-signature@1.0.7` | runtime | `MIT` | [README-license.txt](third-party/licenses/cookie-signature-1.0.7-aa6fdf16/README-license.txt) |
| `core-util-is@1.0.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/core-util-is-1.0.3-40d0aaef/LICENSE.txt) |
| `dashjs@5.2.1` | development | `BSD-3-Clause` | [LICENSE.md.txt](third-party/licenses/dashjs-5.2.1-f9ece998/LICENSE.md.txt) |
| `debounce-promise@3.1.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/debounce-promise-3.1.2-eaa61fde/LICENSE.txt) |
| `debug@2.6.9` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/debug-2.6.9-e7b40ffc/LICENSE.txt) |
| `depd@2.0.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/depd-2.0.0-78a340b1/LICENSE.txt) |
| `destroy@1.2.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/destroy-1.2.0-6801a0b1/LICENSE.txt) |
| `dunder-proto@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/dunder-proto-1.0.1-54633a98/LICENSE.txt) |
| `ee-first@1.1.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/ee-first-1.1.1-d9438890/LICENSE.txt) |
| `emoji-regex@8.0.0` | runtime | `MIT` | [LICENSE-MIT.txt.txt](third-party/licenses/emoji-regex-8.0.0-130be300/LICENSE-MIT.txt.txt) |
| `encodeurl@2.0.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/encodeurl-2.0.0-f855af3d/LICENSE.txt) |
| `es-define-property@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/es-define-property-1.0.1-c81157ba/LICENSE.txt) |
| `es-errors@1.3.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/es-errors-1.3.0-ce536cac/LICENSE.txt) |
| `es-object-atoms@1.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/es-object-atoms-1.1.2-c33c5ba1/LICENSE.txt) |
| `escalade@3.2.0` | runtime | `MIT` | [license.txt](third-party/licenses/escalade-3.2.0-d9e495ab/license.txt) |
| `escape-html@1.0.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/escape-html-1.0.3-27272b4b/LICENSE.txt) |
| `escape-string-regexp@1.0.5` | development | `MIT` | [license.txt](third-party/licenses/escape-string-regexp-1.0.5-fe8ffc90/license.txt) |
| `etag@1.8.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/etag-1.8.1-70a173be/LICENSE.txt) |
| `eventemitter3@4.0.7` | development | `MIT` | [LICENSE.txt](third-party/licenses/eventemitter3-4.0.7-e9eb74a1/LICENSE.txt) |
| `express@4.22.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/express-4.22.3-dac4790a/LICENSE.txt) |
| `fast-deep-equal@3.1.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/fast-deep-equal-3.1.3-1dc28023/LICENSE.txt) |
| `fast-glob@3.3.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/fast-glob-3.3.3-9c8cd3db/LICENSE.txt) |
| `fast-xml-builder@1.3.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/fast-xml-builder-1.3.1-4f3a6997/LICENSE.txt) |
| `fast-xml-parser@5.11.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/fast-xml-parser-5.11.2-d74a2cd2/LICENSE.txt) |
| `fastq@1.20.3` | development | `ISC` | [LICENSE.txt](third-party/licenses/fastq-1.20.3-8c489daf/LICENSE.txt) |
| `fill-range@7.1.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/fill-range-7.1.1-6d6ac572/LICENSE.txt) |
| `finalhandler@1.3.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/finalhandler-1.3.2-7498f428/LICENSE.txt) |
| `forwarded@0.2.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/forwarded-0.2.0-811e8b13/LICENSE.txt) |
| `fresh@0.5.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/fresh-0.5.2-fe46e395/LICENSE.txt) |
| `fs-extra@8.1.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/fs-extra-8.1.0-f95259c7/LICENSE.txt) |
| `fsevents@2.3.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/fsevents-2.3.3-e0a54ee2/LICENSE.txt) |
| `function-bind@1.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/function-bind-1.1.2-f8694b46/LICENSE.txt) |
| `get-caller-file@2.0.5` | runtime | `ISC` | [LICENSE.md.txt](third-party/licenses/get-caller-file-2.0.5-32d72273/LICENSE.md.txt) |
| `get-intrinsic@1.3.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/get-intrinsic-1.3.0-ba0227ed/LICENSE.txt) |
| `get-proto@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/get-proto-1.0.1-4a0fc3d8/LICENSE.txt) |
| `glob-parent@5.1.2` | development | `ISC` | [LICENSE.txt](third-party/licenses/glob-parent-5.1.2-b7d9e1c2/LICENSE.txt) |
| `gopd@1.2.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/gopd-1.2.0-9d45d6c7/LICENSE.txt) |
| `graceful-fs@4.2.11` | development | `ISC` | [LICENSE.txt](third-party/licenses/graceful-fs-4.2.11-d490a6d4/LICENSE.txt) |
| `has-flag@3.0.0` | development | `MIT` | [license.txt](third-party/licenses/has-flag-3.0.0-f1fca093/license.txt) |
| `has-symbols@1.1.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/has-symbols-1.1.0-0d5368b0/LICENSE.txt) |
| `hasown@2.0.4` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/hasown-2.0.4-b4b7d523/LICENSE.txt) |
| `hls.js@1.7.3` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/hls.js-1.7.3-a72ac1e8/LICENSE.txt) |
| `html-entities@2.6.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/html-entities-2.6.0-5a6f19fa/LICENSE.txt) |
| `http-errors@2.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/http-errors-2.0.1-6e70850c/LICENSE.txt) |
| `iconv-lite@0.4.24` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/iconv-lite-0.4.24-b5c92220/LICENSE.txt) |
| `ignore@5.3.2` | development | `MIT` | [LICENSE-MIT.txt](third-party/licenses/ignore-5.3.2-a37e1a18/LICENSE-MIT.txt) |
| `immediate@3.0.6` | development | `MIT` | [LICENSE.txt.txt](third-party/licenses/immediate-3.0.6-034a0c8b/LICENSE.txt.txt) |
| `imsc@1.1.5` | development | `BSD-2-Clause` | [LICENSE.txt](third-party/licenses/imsc-1.1.5-6730a7c5/LICENSE.txt) |
| `inherits@2.0.4` | runtime | `ISC` | [LICENSE.txt](third-party/licenses/inherits-2.0.4-c76937ee/LICENSE.txt) |
| `ipaddr.js@1.9.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/ipaddr.js-1.9.1-8443c23c/LICENSE.txt) |
| `is-binary-path@2.1.0` | development | `MIT` | [license.txt](third-party/licenses/is-binary-path-2.1.0-787a0926/license.txt) |
| `is-extglob@2.1.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/is-extglob-2.1.1-58ea9335/LICENSE.txt) |
| `is-fullwidth-code-point@3.0.0` | runtime | `MIT` | [license.txt](third-party/licenses/is-fullwidth-code-point-3.0.0-5a85b89b/license.txt) |
| `is-glob@4.0.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/is-glob-4.0.3-effcbb19/LICENSE.txt) |
| `is-number@7.0.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/is-number-7.0.0-cea938ad/LICENSE.txt) |
| `is-unsafe@2.0.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/is-unsafe-2.0.2-29bfa61f/LICENSE.txt) |
| `isarray@1.0.0` | development | `MIT` | [README-license.txt](third-party/licenses/isarray-1.0.0-4f959bdf/README-license.txt) |
| `jsonc-parser@2.3.1` | development | `MIT` | [LICENSE.md.txt](third-party/licenses/jsonc-parser-2.3.1-07fe9248/LICENSE.md.txt) |
| `jsonfile@4.0.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/jsonfile-4.0.0-a5a7392e/LICENSE.txt) |
| `jszip@3.10.2` | development | `(MIT OR GPL-3.0-or-later)` | [LICENSE.markdown.txt](third-party/licenses/jszip-3.10.2-7041c1fb/LICENSE.markdown.txt) |
| `lie@3.3.0` | development | `MIT` | [license.md.txt](third-party/licenses/lie-3.3.0-85055e69/license.md.txt) |
| `lie@3.1.1` | development | `MIT` | [license.md.txt](third-party/licenses/lie-3.1.1-ce549a49/license.md.txt) |
| `localforage@1.10.0` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/localforage-1.10.0-5413b03c/LICENSE.txt) |
| `lodash.isequal@4.5.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/lodash.isequal-4.5.0-52ab5f4e/LICENSE.txt) |
| `math-intrinsics@1.1.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/math-intrinsics-1.1.0-2e6b80fb/LICENSE.txt) |
| `media-typer@0.3.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/media-typer-0.3.0-c79520d2/LICENSE.txt) |
| `merge-descriptors@1.0.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/merge-descriptors-1.0.3-8d8ef495/LICENSE.txt) |
| `merge2@1.4.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/merge2-1.4.1-37699fae/LICENSE.txt) |
| `methods@1.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/methods-1.1.2-40cc6438/LICENSE.txt) |
| `micromatch@4.0.8` | development | `MIT` | [LICENSE.txt](third-party/licenses/micromatch-4.0.8-334c7b92/LICENSE.txt) |
| `mime@1.6.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/mime-1.6.0-4c3ef947/LICENSE.txt) |
| `mime-db@1.52.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/mime-db-1.52.0-086e8d7d/LICENSE.txt) |
| `mime-types@2.1.35` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/mime-types-2.1.35-8469a1f1/LICENSE.txt) |
| `ms@2.0.0` | runtime | `MIT` | [license.md.txt](third-party/licenses/ms-2.0.0-e411571e/license.md.txt) |
| `needle@3.5.0` | development | `MIT` | [license.txt.txt](third-party/licenses/needle-3.5.0-b6063a2a/license.txt.txt) |
| `iconv-lite@0.6.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/iconv-lite-0.6.3-3ecfb928/LICENSE.txt) |
| `sax@1.6.1` | development | `BlueOak-1.0.0` | [LICENSE.md.txt](third-party/licenses/sax-1.6.1-914dd84d/LICENSE.md.txt) |
| `negotiator@0.6.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/negotiator-0.6.3-915dcd78/LICENSE.txt) |
| `normalize-path@3.0.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/normalize-path-3.0.0-d9e74240/LICENSE.txt) |
| `object-inspect@1.13.4` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/object-inspect-1.13.4-6838057a/LICENSE.txt) |
| `on-finished@2.4.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/on-finished-2.4.2-1ef75324/LICENSE.txt) |
| `pako@1.0.11` | development | `(MIT AND Zlib)` | [LICENSE.txt](third-party/licenses/pako-1.0.11-e48e67e0/LICENSE.txt), [lib_zlib_README.txt](third-party/licenses/pako-1.0.11-e48e67e0/lib_zlib_README.txt) |
| `parseurl@1.3.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/parseurl-1.3.3-f80b1a80/LICENSE.txt) |
| `path-browserify@1.0.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/path-browserify-1.0.1-482dd0f7/LICENSE.txt) |
| `path-expression-matcher@1.6.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/path-expression-matcher-1.6.2-d23ea46e/LICENSE.txt) |
| `path-to-regexp@0.1.13` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/path-to-regexp-0.1.13-b738fd2a/LICENSE.txt) |
| `picomatch@2.3.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/picomatch-2.3.2-75ffdfef/LICENSE.txt) |
| `playwright@1.64.1` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/playwright-1.64.1-14fe0a40/LICENSE.txt), [NOTICE.txt](third-party/licenses/playwright-1.64.1-14fe0a40/NOTICE.txt), [ThirdPartyNotices.txt.txt](third-party/licenses/playwright-1.64.1-14fe0a40/ThirdPartyNotices.txt.txt) |
| `playwright-core@1.64.1` | development | `Apache-2.0` | [LICENSE.txt](third-party/licenses/playwright-core-1.64.1-39d2ef0c/LICENSE.txt), [NOTICE.txt](third-party/licenses/playwright-core-1.64.1-39d2ef0c/NOTICE.txt), [ThirdPartyNotices.txt.txt](third-party/licenses/playwright-core-1.64.1-39d2ef0c/ThirdPartyNotices.txt.txt) |
| `process-nextick-args@2.0.1` | development | `MIT` | [license.md.txt](third-party/licenses/process-nextick-args-2.0.1-68c9e75c/license.md.txt) |
| `proxy-addr@2.0.8` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/proxy-addr-2.0.8-7f261d77/LICENSE.txt) |
| `qs@6.16.2` | runtime | `BSD-3-Clause` | [LICENSE.md.txt](third-party/licenses/qs-6.16.2-0b5a5f35/LICENSE.md.txt) |
| `queue-microtask@1.2.3` | development | `MIT` | [LICENSE.txt](third-party/licenses/queue-microtask-1.2.3-01b607ea/LICENSE.txt) |
| `range-parser@1.2.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/range-parser-1.2.1-e3fd31cc/LICENSE.txt) |
| `raw-body@2.5.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/raw-body-2.5.3-7a3d4724/LICENSE.txt) |
| `readable-stream@2.3.8` | development | `MIT` | [LICENSE.txt](third-party/licenses/readable-stream-2.3.8-6a0eabf7/LICENSE.txt) |
| `safe-buffer@5.1.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/safe-buffer-5.1.2-d9c942ef/LICENSE.txt) |
| `readdirp@3.6.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/readdirp-3.6.0-4d959cdf/LICENSE.txt) |
| `regexp-to-ast@0.5.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/regexp-to-ast-0.5.0-6c59855a/LICENSE.txt) |
| `require-directory@2.1.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/require-directory-2.1.1-0653778c/LICENSE.txt) |
| `require-relative@0.8.7` | development | `MIT` | [published-license-declaration.json](third-party/licenses/require-relative-0.8.7-dc5e6b56/published-license-declaration.json), [MIT-standard.txt](third-party/sources/MIT-standard.txt) |
| `reusify@1.1.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/reusify-1.1.0-9e087af9/LICENSE.txt) |
| `roku-deploy@3.18.4` | development | `MIT` | [LICENSE.txt](third-party/licenses/roku-deploy-3.18.4-ead962d7/LICENSE.txt) |
| `fs-extra@7.0.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/fs-extra-7.0.1-80472233/LICENSE.txt) |
| `run-parallel@1.2.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/run-parallel-1.2.0-e10fa5f7/LICENSE.txt) |
| `safe-buffer@5.2.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/safe-buffer-5.2.1-bce944be/LICENSE.txt) |
| `safer-buffer@2.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/safer-buffer-2.1.2-d9639c5e/LICENSE.txt) |
| `sax@1.2.1` | development | `ISC` | [LICENSE.txt](third-party/licenses/sax-1.2.1-45a7cd8e/LICENSE.txt), [LICENSE-W3C.html.txt](third-party/licenses/sax-1.2.1-45a7cd8e/LICENSE-W3C.html.txt) |
| `semver@7.8.5` | development | `ISC` | [LICENSE.txt](third-party/licenses/semver-7.8.5-e295d2ab/LICENSE.txt) |
| `send@0.19.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/send-0.19.2-dfaab080/LICENSE.txt) |
| `ms@2.1.3` | runtime | `MIT` | [license.md.txt](third-party/licenses/ms-2.1.3-638facb3/license.md.txt) |
| `serve-static@1.16.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/serve-static-1.16.3-165a11af/LICENSE.txt) |
| `setimmediate@1.0.5` | development | `MIT` | [LICENSE.txt.txt](third-party/licenses/setimmediate-1.0.5-e37b2c25/LICENSE.txt.txt) |
| `setprototypeof@1.2.0` | runtime | `ISC` | [LICENSE.txt](third-party/licenses/setprototypeof-1.2.0-64a15ed4/LICENSE.txt) |
| `side-channel@1.1.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/side-channel-1.1.1-bc506c0c/LICENSE.txt) |
| `side-channel-list@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/side-channel-list-1.0.1-c25540f0/LICENSE.txt) |
| `side-channel-map@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/side-channel-map-1.0.1-5afe8e3f/LICENSE.txt) |
| `side-channel-weakmap@1.0.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/side-channel-weakmap-1.0.2-5f7ccd73/LICENSE.txt) |
| `source-map@0.7.6` | development | `BSD-3-Clause` | [LICENSE.txt](third-party/licenses/source-map-0.7.6-958e49d9/LICENSE.txt) |
| `statuses@2.0.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/statuses-2.0.2-14402378/LICENSE.txt) |
| `string_decoder@1.1.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/string_decoder-1.1.1-e7ae557c/LICENSE.txt) |
| `safe-buffer@5.1.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/safe-buffer-5.1.2-c26447e9/LICENSE.txt) |
| `string-width@4.2.3` | runtime | `MIT` | [license.txt](third-party/licenses/string-width-4.2.3-0af48960/license.txt) |
| `strip-ansi@6.0.1` | runtime | `MIT` | [license.txt](third-party/licenses/strip-ansi-6.0.1-b139d9d5/license.txt) |
| `strnum@2.5.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/strnum-2.5.1-6a594752/LICENSE.txt) |
| `supports-color@5.5.0` | development | `MIT` | [license.txt](third-party/licenses/supports-color-5.5.0-f85f2f40/license.txt) |
| `thenby@1.4.1` | development | `Apache-2.0` | [LICENSE.TXT.txt](third-party/licenses/thenby-1.4.1-0726f649/LICENSE.TXT.txt) |
| `to-regex-range@5.0.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/to-regex-range-5.0.1-66ac695c/LICENSE.txt) |
| `toidentifier@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/toidentifier-1.0.1-2456b6b9/LICENSE.txt) |
| `type-is@1.6.18` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/type-is-1.6.18-bb6eb299/LICENSE.txt) |
| `typescript@5.2.2` | development | `Apache-2.0` | [LICENSE.txt.txt](third-party/licenses/typescript-5.2.2-ab4a5bf0/LICENSE.txt.txt), [ThirdPartyNoticeText.txt.txt](third-party/licenses/typescript-5.2.2-ab4a5bf0/ThirdPartyNoticeText.txt.txt) |
| `undici-types@7.24.6` | development | `MIT` | [LICENSE.txt](third-party/licenses/undici-types-7.24.6-caa71619/LICENSE.txt) |
| `universalify@0.1.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/universalify-0.1.2-0723d71f/LICENSE.txt) |
| `unpipe@1.0.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/unpipe-1.0.0-a8d5ed3a/LICENSE.txt) |
| `util-deprecate@1.0.2` | development | `MIT` | [LICENSE.txt](third-party/licenses/util-deprecate-1.0.2-be19f75f/LICENSE.txt) |
| `utils-merge@1.0.1` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/utils-merge-1.0.1-6b1e2242/LICENSE.txt) |
| `vary@1.1.2` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/vary-1.1.2-3b75c7c5/LICENSE.txt) |
| `vscode-jsonrpc@10.0.0` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-jsonrpc-10.0.0-514fe282/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-jsonrpc-10.0.0-514fe282/thirdpartynotices.txt.txt) |
| `vscode-languageserver@9.0.1` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-9.0.1-e4888314/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-9.0.1-e4888314/thirdpartynotices.txt.txt) |
| `vscode-languageserver-protocol@3.18.5` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-protocol-3.18.5-2cd555de/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-protocol-3.18.5-2cd555de/thirdpartynotices.txt.txt) |
| `vscode-languageserver-textdocument@1.0.16` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-textdocument-1.0.16-3e45d222/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-textdocument-1.0.16-3e45d222/thirdpartynotices.txt.txt) |
| `vscode-languageserver-types@3.18.5` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-types-3.18.5-493557e1/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-types-3.18.5-493557e1/thirdpartynotices.txt.txt) |
| `vscode-jsonrpc@8.2.0` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-jsonrpc-8.2.0-9c008e62/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-jsonrpc-8.2.0-9c008e62/thirdpartynotices.txt.txt) |
| `vscode-languageserver-protocol@3.17.5` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-protocol-3.17.5-e370e39e/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-protocol-3.17.5-e370e39e/thirdpartynotices.txt.txt) |
| `vscode-languageserver-types@3.17.5` | development | `MIT` | [License.txt.txt](third-party/licenses/vscode-languageserver-types-3.17.5-153b3961/License.txt.txt), [thirdpartynotices.txt.txt](third-party/licenses/vscode-languageserver-types-3.17.5-153b3961/thirdpartynotices.txt.txt) |
| `vscode-uri@3.2.0` | development | `MIT` | [LICENSE.md.txt](third-party/licenses/vscode-uri-3.2.0-12ac20fa/LICENSE.md.txt) |
| `wrap-ansi@7.0.0` | runtime | `MIT` | [license.txt](third-party/licenses/wrap-ansi-7.0.0-142e8c61/license.txt) |
| `xml-naming@0.3.0` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/xml-naming-0.3.0-4e39a31e/LICENSE.txt) |
| `xml2js@0.5.0` | development | `MIT` | [LICENSE.txt](third-party/licenses/xml2js-0.5.0-c9494327/LICENSE.txt) |
| `xmlbuilder@11.0.1` | development | `MIT` | [LICENSE.txt](third-party/licenses/xmlbuilder-11.0.1-b0b86f9a/LICENSE.txt) |
| `y18n@5.0.8` | runtime | `ISC` | [LICENSE.txt](third-party/licenses/y18n-5.0.8-9a8ac12d/LICENSE.txt) |
| `yargs@17.7.3` | runtime | `MIT` | [LICENSE.txt](third-party/licenses/yargs-17.7.3-bd1626d7/LICENSE.txt) |
| `yargs-parser@21.1.1` | runtime | `ISC` | [LICENSE.txt.txt](third-party/licenses/yargs-parser-21.1.1-7c4a9dcd/LICENSE.txt.txt) |

Regenerate from a clean full development install with `npm run notices:generate`.
Run `npm run notices:check` to detect lockfile drift, missing notices or altered
texts. Existing verified notice data supports optional packages absent on the
current platform; a new missing platform package fails explicitly.
