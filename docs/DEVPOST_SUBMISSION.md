# Devpost submission draft

## Submission fields

- **Project:** Forkcast
- **Tagline:** Decision intelligence, not decision replacement.
- **Repository:** https://github.com/652036/forkcast
- **Working native WebMCP app:** https://forkcast.st2p8g4tkf.chatgpt.site/
- **Under-three-minute video (target 2:43):** `REPLACE_WITH_PUBLIC_VIDEO_URL`
- **GitHub Pages visual/Tool Lab preview:** https://652036.github.io/forkcast/

The GitHub Pages fallback does not preserve the project-defined `_headers`; use the production URL above, where native registration can be verified directly.

## Inspiration

AI can help with consequential choices, but the reasoning often disappears inside a chat transcript. People receive a confident recommendation without an inspectable record of alternatives, values, evidence quality, or unresolved assumptions. We wanted the browser page—not the chat—to become a durable workspace where a person and an agent can build the decision together.

## What it does

Forkcast is a local-first decision studio built around WebMCP. A browser agent can read the current workspace, define the brief, add alternatives and criteria, record scores with evidence and confidence, create scenarios, surface evidence gaps, run a seeded Monte Carlo stress test, and stage a recommendation through typed page tools.

Every action changes the same state the person sees. The ranking, matrix, latest shared action, assumptions, scenario, uncertainty result, and audit trail update immediately. Tools are context-aware: operations disappear when their preconditions do not hold, and all mutation tools disappear after commitment.

The authority boundary is structural. Forkcast exposes no commit or finalize site tool. A WebMCP agent may stage a recommendation, but finalization is reserved for the visible review control and explicit user confirmation. Agent undo is also scoped so it cannot roll back a newer user edit.

## How we built it

Forkcast is a dependency-free static PWA using semantic HTML, modern CSS, and JavaScript modules. The WebMCP adapter targets the current imperative API at top-level `document.modelContext.registerTool()`. It:

- registers closed, described JSON Schemas and the current `readOnlyHint` / `untrustedContentHint` annotations;
- awaits every registration promise before reporting a native connection;
- unregisters obsolete tools with `AbortController` before registering a changed set;
- fingerprints definitions so ordinary state refreshes do not churn the native registry;
- returns ordinary structured values while validation, cancellation, and domain failures reject natively;
- pages one item at a time, fragments long text, and keeps every serialized read below 3,000 characters (about 1,500 by default) while complete data remains retrievable; and
- exposes the same validated handlers in a built-in Tool Lab for deterministic inspection.

The decision engine normalizes criterion weights, layers sparse scenario overrides without mutating the base case, ranks options, finds active-scenario evidence gaps, and runs reproducible uncertainty simulations in cancellable asynchronous chunks. Hydration validates shape, version, ids, references, and size limits. State remains in `localStorage`; writes commit transactionally, and a service worker caches the app shell for offline use.

## Challenges we ran into

The hardest product question was where agent authority must stop. A warning in a prompt was not enough, so we made commitment unavailable at the tool layer and made mutation controls read-only after a human commits.

The hardest protocol issue was dynamic registration. `registerTool()` is asynchronous, while application state can change during a tool call. Treating registration as synchronous can show a false “connected” state or leave partial tools after a rejection. We added explicit readiness, generation checks, abort-based cleanup, stable fingerprints, and native-path lifecycle tests.

Deployment was another subtle failure mode. Native WebMCP requires an origin-keyed context and permission to use the `tools` feature. The production bundle explicitly configures both, the local server emits the same headers, and the verification suite smoke-tests the built site over HTTP. We keep GitHub Pages as a visual fallback because it strips project-defined response headers.

## Accomplishments we are proud of

- A complete decision workflow rather than a one-shot novelty tool.
- Human and agent share one live, visible source of truth.
- Evidence quality changes the math, not just the decoration.
- Scenario rankings, matrix cells, and gap detection resolve against the same active layer.
- Context-aware tools expose only actions that can succeed now.
- Native failures return retryable messages instead of opaque browser errors.
- Final commitment is absent from the WebMCP surface, and newer user edits remain outside agent undo authority.
- The zero-dependency app works locally, offline after first load, and on static hosting.
- Automated verification covers 17 engine, schema, result-normalization, and native-registry lifecycle cases plus a production HTTP smoke test.

## Judging narrative

### Usefulness

Teams repeatedly make launch, hiring, vendor, location, and product-priority decisions. Forkcast turns those messy discussions into a portable record with explicit values, evidence gaps, uncertainty, and ownership of the final choice.

### Originality

Forkcast is not a chat wrapper or form-filling shortcut. It treats the browser page as a human-agent decision instrument: the agent changes a transparent analytical model, uncertainty affects simulation, and authority narrows as the decision advances.

### Execution

The experience is responsive, keyboard-accessible, dark-mode aware, local-first, offline-capable, dependency-free, tested, and deployable as a hardened static build. Native registration success and failure are both represented honestly in the UI.

### Thoughtful use of WebMCP

Tools map to atomic domain operations rather than clicks. They accept raw decision inputs, return stable ids and structured state, declare strict schemas and trust annotations, handle abort-driven lifecycle changes, and register dynamically from real page state.

### Human–agent experience

Agent work appears immediately in the ranking, evidence matrix, “Last shared action” card, and audit trail. The agent can focus the person’s view and stage a rationale, while the person can edit, inspect, undo, challenge, or commit. The final boundary is visible and enforced by tool availability.

## What we learned

WebMCP is most valuable when it exposes a product’s domain model rather than mirroring its buttons. Clear schemas help the agent plan, but a trustworthy agentic product also needs visible state, useful error results, reversible work, trust labeling, and authority that changes with context.

## What’s next

Future versions could add collaborative workspaces, signed evidence sources, reusable decision templates, sensitivity charts, and organization-level decision policies while preserving the human commitment boundary.

## Built with

WebMCP imperative API, JavaScript modules, semantic HTML, CSS, localStorage, Service Worker, Node.js test runner, GitHub Actions, and OpenAI Sites/static hosting.
