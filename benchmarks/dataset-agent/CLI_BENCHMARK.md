# CLI runs for benchmark prompts (agent enabled)

Mirror benchmark criteria on the collection CLI with full artifacts under `runs/benchmark-cli/`.

| Setting | Value |
|---------|--------|
| Prompts | `benchmarks/dataset-agent/prompts.json` (16 entries) |
| Target rows | `8` (same as `COLLECTION_AGENT_TARGET_ROWS`) |
| Repair | off by default (same as benchmark); pass `--repair` to enable |
| Triage | on |
| Tinyfish agent | **on** (default; never pass `--no-agent`) |
| Required columns | from each prompt’s `requiredColumns` |

## Run all prompts

From `backend/BigSet_Data_Collection_Agent`:

```bash
npm run collect:benchmark
```

Options:

```bash
npm run collect:benchmark -- --dry-run          # write cli-prompts.sh only
npm run collect:benchmark -- --only saas-pricing-pages,07-ny-ai-startup-careers
npm run collect:benchmark -- --repair           # enable repair loop
npm run collect:benchmark -- --target-rows 25   # CLI-style target rows
```

After a full run, see `runs/benchmark-cli/manifest.json` for `run_id` → prompt mapping.

## Run one prompt manually

Example (agent enabled — no `--no-agent`):

```bash
cd backend/BigSet_Data_Collection_Agent
npm run collect -- run \
  -p "AI startups in New York that have careers pages. I want company name, website, and whether they look like they are hiring." \
  -t 8 \
  --no-repair \
  -o runs/benchmark-cli/07-ny-ai-startup-careers \
  --required-columns entity_name,company_website,careers_page_url,is_hiring \
  --expected-stress "Careers-page verification with partial data accepted."
```

## Shell script reference

`cli-prompts.sh` is regenerated on each `collect:benchmark` run (including `--dry-run`). Execute individual sections or the whole file:

```bash
bash benchmarks/dataset-agent/cli-prompts.sh
```

Each prompt writes to `runs/benchmark-cli/<NN>-<prompt-id>/<run_id>/` with `run_report.json`, CSVs, and pages.
