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

### How a job is launched

1. The agent reads `job.settings.json` from the job's working directory.
2. It runs `program[os]` with `args` (plus any inputs it appends, such as a
   postal code / location).
3. The program reads the `settings` block itself for any program-defined options.

So `args` carry **command-line inputs** while `settings` carry **program-defined
configuration** — keep job-specific filters and options in `settings`.
