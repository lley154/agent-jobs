## Every job needs a `job.settings.json` manifest

For a calling application or agent to run a job, that job's working directory
**must contain a `job.settings.json` manifest**. The manifest is what the agent
reads to learn *how* to launch the job — it does not run the job itself.

A generic template lives at the repo root: [`job.settings.json.template`](./job.settings.json.template).
Copy it into a job directory and fill it in. For a real example, see
[`property-search/ca/job.settings.json`](./property-search/ca/job.settings.json).

```json
{
  "version": 1,
  "name": "Property Search (Canada)",
  "description": "Watch realtor.ca for new MLS listings by postal code or location.",
  "program": { "linux": "watch.sh", "macos": "watch.sh", "windows": "watch.cmd" },
  "args": ["--headless"],
  "settings": { "propertyType": "residential", "priceMin": 0, "priceMax": 0 }
}
```

### Fields

| Field | Read by | Purpose |
| --- | --- | --- |
| `version` | agent | Manifest schema version (currently `1`). |
| `name` / `description` | agent | Human-readable label shown to the agent. |
| `program` | agent | Maps the host OS (`linux` / `macos` / `windows`) to the executable to launch, relative to the job directory. |
| `args` | agent | Command-line arguments passed to the program. The agent may **append** further inputs (e.g. a search location) after these. |
| `settings` | **the program** | Program-defined options. The agent does **not** interpret these — the job reads its own `settings` block from its working directory. |
| `init` | agent | *(optional)* One-time setup the agent runs **before** the job is first used (install deps, sign in, warm a browser profile). See [One-time initialization](#one-time-initialization-init). |

### How a job is launched

1. The agent reads `job.settings.json` from the job's working directory.
2. It runs `program[os]` with `args` (plus any inputs it appends, such as a
   postal code / location).
3. The program reads the `settings` block itself for any program-defined options.

So `args` carry **command-line inputs** while `settings` carry **program-defined
configuration** — keep job-specific filters and options in `settings`.

### One-time initialization (`init`)

A job often needs a one-time setup before its first run — installing
dependencies, signing in, or clearing a bot check. Declare it under an optional
`init` object so a calling agent can perform it **without manual steps** and
refuse to save the job if setup fails.

```jsonc
"init": {
  "requires": ["node"],            // runtimes to ensure first (currently: "node")
  "steps": [
    {
      "id": "install",
      "title": "Install dependencies",
      "run": { "linux": "npm install", "macos": "npm install", "windows": "npm install" }
    },
    {
      "id": "warm-profile",
      "title": "Sign in / clear the bot check",
      "interactive": true,         // the agent launches this and waits for the user
      "instructions": "A browser window will open. Solve any check, then close it.",
      "launch": { "linux": "…", "macos": "…", "windows": "…" }
    }
  ],
  "verify": { "linux": "test -d \"$HOME/.realtor-chrome\"", "macos": "…", "windows": "…" }
}
```

| Key | Purpose |
| --- | --- |
| `requires` | Runtimes to ensure before any step runs. `"node"` ⇒ use the system Node.js + npm if present, otherwise install a private copy the job's commands will use. |
| `steps[]` | Ordered setup steps. Each is **either** `run` (a non-interactive OS-keyed command that must exit `0`) **or** `launch` + `"interactive": true` (an OS-keyed command the agent starts and waits for the user to finish — show `instructions`). A step with no command for the host OS is skipped. |
| `verify` | *(optional)* A final OS-keyed command; a non-zero exit means setup failed. |

Commands are full shell strings run in the job's working directory. The agent
records success so subsequent uses skip the setup; on any failure it reports the
failing step and does not save the job. A job with no `init` needs no setup.
