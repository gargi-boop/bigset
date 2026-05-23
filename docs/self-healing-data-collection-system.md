# Self-Healing Data Collection System

## One-Liner

BigSet now has a safety wrapper around data collection. It does not make the agent magically smarter; it prevents bad or unsupported output from being promoted, counted as success, or committed without guardrails.

## System Map

```mermaid
flowchart LR
  A["Dataset request"] --> B["BigSet app<br/>/populate"]

  subgraph R["Collection runtimes"]
    C["Mastra<br/>app-integrated target"]
    D["Collection agent<br/>logic being migrated"]
  end

  B --> C
  B --> D
  D -. "migrate into" .-> C

  subgraph S["Self-healing layer"]
    E["Run collection"]
    F["Validate rows, sources, evidence"]
    G["Promote good recipe"]
    H["Reject bad candidate"]
    I["Cap real commits<br/>100 rows/hour/dataset"]
  end

  C --> E
  D --> E
  E --> F
  F -->|"good"| G --> I
  F -->|"bad"| H

  subgraph P["Browser replay path"]
    J["Process trace"]
    K["Explicit browser actions"]
    L["Playwright candidate script"]
    M["Cron replay<br/>future"]
    N["Script repair loop<br/>future"]
  end

  E --> J --> K --> L
  L -. "future" .-> M
  M -. "fails" .-> N
  N -. "repair" .-> L
```

Raw Mermaid source lives in [`self-healing-data-collection-system.mmd`](./self-healing-data-collection-system.mmd).

## Components

- **Mastra**: the app-integrated agent framework path.
- **Collection agent**: the collection pipeline being migrated into the app-integrated framework path.
- **Self-healing layer**: runtime-agnostic safety wrapper around either collection path.
- **Process trace**: durable diagnostic trace of what happened during collection.
- **Explicit browser actions**: ordered browser work emitted by the producer, such as navigation, click, type, select, wait, and extract actions.
- **Playwright candidate script**: generated replay artifact from explicit browser actions. This is not a promoted cron recipe yet.

## What Works Now

- Run collection through the self-healing wrapper.
- Validate rows, source URLs, evidence, and expected entities.
- Promote or save only healthy recipes.
- Reject bad candidates.
- Count rejected candidates as benchmark failures.
- Commit real rows only after a successful tick.
- Cap real row commits at 100 rows/hour per dataset by default.
- Emit process trace and Playwright-readiness diagnostics.
- Preserve explicit browser actions when the producer emits them.
- Generate a bounded Playwright candidate script from explicit successful browser actions.

## What Is Not Done Yet

- Durable cron job that reruns the generated Playwright script.
- Auto-repair loop for broken Playwright scripts.
- Live key-backed canary proving browser-action readiness end to end.
- Final migration of collection-agent behavior into one app-integrated runtime path.

## Intended End State

```mermaid
flowchart LR
  A["Agent collects once"] --> B["Self-healing validates"]
  B --> C["Generate durable Playwright recipe"]
  C --> D["Cron reruns cheap script"]
  D -->|"works"| E["Fresh rows update"]
  D -->|"breaks"| F["Agent reruns live collection"]
  F --> G["Repair Playwright script"]
  G --> C
```

## Review Notes

Use `<br/>` for line breaks inside Mermaid labels. Some renderers display backslash-n literally.

For sharing, paste the raw `.mmd` file into [Mermaid Live](https://mermaid.live), then export PNG or SVG.
