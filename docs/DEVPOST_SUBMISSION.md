# Devpost submission draft

## Submission fields

- **Project:** Forkcast
- **Tagline:** Decision intelligence, not decision replacement.
- **Repository:** https://github.com/652036/forkcast
- **Working native WebMCP app:** https://forkcast.st2p8g4tkf.chatgpt.site/
- **Under-three-minute video (target 2:43):** **TODO(video)** — paste the public URL here before submitting; do not submit with this placeholder.
- **GitHub Pages visual/Tool Lab preview:** https://652036.github.io/forkcast/

Use the production URL above for native verification. Native WebMCP works there through browser defaults (top-level `tools=self`, origin-keyed agent cluster); ChatGPT Sites does not apply custom response headers, and neither does the GitHub Pages fallback.

## Inspiration

AI can help with consequential choices, but the reasoning often disappears inside a chat transcript. People receive a confident recommendation without an inspectable record of alternatives, values, evidence quality, or unresolved assumptions. We wanted the browser page—not the chat—to become a durable workspace where a person and an agent can build the decision together.

## What it does

Forkcast is a local-first decision studio built around WebMCP. A browser agent can read the current workspace, define the brief, add alternatives and criteria, record scores with evidence and confidence, create scenarios, surface evidence gaps, run a seeded Monte Carlo stress test, and stage a recommendation through typed page tools.

Every action changes the same state the person sees. The ranking, matrix, latest shared action, assumptions, scenario, uncertainty result, and audit trail update immediately. The tool set stays stable while a decision is open—unmet preconditions return readable errors—and authority narrows structurally: all write tools are unregistered after the human commits.

The authority boundary is structural. Forkcast exposes no commit or finalize site tool. A WebMCP agent may stage a recommendation, but finalization is reserved for the visible review control and explicit user confirmation. Agent undo is also scoped so it cannot roll back a newer user edit.

## How we built it

Forkcast is a dependency-free static PWA using semantic HTML, modern CSS, and JavaScript modules. The WebMCP adapter targets the current imperative API at top-level `document.modelContext.registerTool()`. It:

- registers closed, described JSON Schemas and the current `readOnlyHint` / `untrustedContentHint` annotations;
- awaits every registration promise before reporting a native connection;
- gives every tool its own `AbortController` and diffs refreshes by name and definition fingerprint, so only removed or changed tools are aborted and only new or changed tools are registered;
- defers registry changes requested during an in-flight call until that call returns, so a handler never cancels its own invocation;
- returns ordinary structured values while validation, cancellation, and domain failures reject natively;
- pages every section independently (8 items by default, 25 at most), fragments long text, and shrinks pages to stay below 12,000 serialized characters while complete data remains retrievable by cursor; and
- exposes the same validated handlers in a built-in Tool Lab for deterministic inspection.

The decision engine normalizes criterion weights, layers sparse scenario overrides without mutating the base case, ranks options, finds active-scenario evidence gaps, and runs reproducible uncertainty simulations in cancellable asynchronous chunks. Hydration validates shape, version, ids, references, and size limits. State remains in `localStorage`; writes commit transactionally, and a service worker caches the app shell for offline use.

## Challenges we ran into

The hardest product question was where agent authority must stop. A warning in a prompt was not enough, so we made commitment unavailable at the tool layer and made mutation controls read-only after a human commits.

The hardest protocol issue was dynamic registration. `registerTool()` is asynchronous, application state changes during a tool call, and older Chrome builds cancel an in-progress call when its tool is unregistered. Treating registration as synchronous can show a false “connected” state, leave partial tools after a rejection, or abort the very call that triggered a refresh. We moved to per-tool controllers with name/fingerprint diffing, deferred refreshes until in-flight calls return, kept the tool set stable until commitment, and covered each path with native-lifecycle tests.

Deployment was another subtle failure mode. Native WebMCP requires a top-level document with the `tools` feature allowed; both hold by browser default, but static hosts such as ChatGPT Sites and GitHub Pages do not apply custom response headers, so nothing may depend on them. We kept `_headers` as optional hardening for header-capable hosts, made the runtime refuse native registration inside frames, and added `npm run check:prod`, which byte-compares the deployed `src/app.js` with the repository so a stale deployment cannot masquerade as the submitted build.

## Accomplishments we are proud of

- A complete decision workflow rather than a one-shot novelty tool.
- Human and agent share one live, visible source of truth.
- Evidence quality changes the math, not just the decoration.
- Scenario rankings, matrix cells, and gap detection resolve against the same active layer.
- A stable tool set with readable precondition errors, and write tools that structurally disappear after commitment.
- Native failures return retryable messages instead of opaque browser errors.
- Final commitment is absent from the WebMCP surface, and newer user edits remain outside agent undo authority.
- The zero-dependency app works locally, offline after first load, and on static hosting.
- Automated verification covers 43 engine, tool-layer, schema, storage, result-normalization, and native-registry lifecycle cases, plus an HTTP smoke test of the built site and a separate live production check (`npm run check:prod`).

## Judging narrative

### Usefulness

Teams repeatedly make launch, hiring, vendor, location, and product-priority decisions. Forkcast turns those messy discussions into a portable record with explicit values, evidence gaps, uncertainty, and ownership of the final choice.

### Originality

Forkcast is not a chat wrapper or form-filling shortcut. It treats the browser page as a human-agent decision instrument: the agent changes a transparent analytical model, uncertainty affects simulation, and authority narrows as the decision advances.

### Execution

The experience is responsive, keyboard-accessible, dark-mode aware, local-first, offline-capable, dependency-free, tested, and deployable as a plain static build with a strict CSP (no inline styles or scripts). Native registration success, failure, and the reason native mode is unavailable are all represented honestly in the UI.

### Thoughtful use of WebMCP

Tools map to atomic domain operations rather than clicks. They accept raw decision inputs, return stable ids and structured state, declare strict schemas and trust annotations, keep a stable registry that narrows only when the human commits, and never cancel their own in-flight calls.

### Human–agent experience

Agent work appears immediately in the ranking, evidence matrix, “Last shared action” card, and audit trail. The agent can focus the person’s view and stage a rationale, while the person can edit, inspect, undo, challenge, or commit. The final boundary is visible and enforced by tool availability.

## What we learned

WebMCP is most valuable when it exposes a product’s domain model rather than mirroring its buttons. Clear schemas help the agent plan, but a trustworthy agentic product also needs visible state, useful error results, reversible work, trust labeling, and authority that changes with context.

## What’s next

Future versions could add collaborative workspaces, signed evidence sources, reusable decision templates, sensitivity charts, and organization-level decision policies while preserving the human commitment boundary.

## Built with

WebMCP imperative API, JavaScript modules, semantic HTML, CSS, localStorage, Service Worker, Node.js test runner, GitHub Actions, and OpenAI Sites/static hosting.
