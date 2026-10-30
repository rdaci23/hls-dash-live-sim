# Source provenance

Extracted from `original private tools project`, local branch `feature/dummy-live-stream`.

Source commit: `ccf0077f5614283a1bc8a7721d1fffc965a59c41` (2025-11-10, Fix container reuse and port conflict handling).

The branch was present locally but not returned by the remote branch search.
The six simulator modules, HLS media, static asset copier and fault guide were
recovered from that commit. The CLI retains only simulator and template commands.
Standalone generation, debugger, deployment, and SDK dependencies are excluded.
The original repositories and branches were left untouched.

On 30 October 2026, the maintainer confirmed that they implemented the simulator
as part of the original tools project and have authority to publish it as a
separate repository. The public source/media license remains to be selected.

Standalone adaptations:

- Personal package name, CLI, scripts, build and dependency lockfile.
- Independent config filenames, Docker container names and cache directory.
- Template HLS commands use the bundled Node proxy rather than Docker VoD mode.
- Missing fault files are created so live updates work on a fresh clone.
- Control UI one-shot injections persist to the watched file across processes.
- `--manifest-url` alias and `--no-pull` parsing work with yargs.
- Original saved templates recovered locally into the ignored template file.

Validation at extraction: TypeScript build and typecheck passed. Three integration
tests passed, covering HLS media, template startup, live fault control across
processes, DASH parsing and the DASH fault proxy. Docker was installed but its
daemon was not running, so full livesim2 backend playback was not verified.

The original branch was work in progress. Template labels describe intended
scenarios; they do not guarantee encoded media bitrate, latency, DRM or ad parity.
