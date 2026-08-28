# Devpost submission draft

## Project name

Forkcast

## Tagline

Decision intelligence, not decision replacement.

## Inspiration

AI agents are increasingly able to act inside software, but consequential decisions still collapse into opaque chat transcripts. We wanted a workspace where an agent could do real analytical work while every assumption, score, and change remained visible to the person responsible for the outcome.

## What it does

Forkcast is a local-first decision studio built around WebMCP. A browser agent can define a decision, add alternatives, edit criteria, record evidence and confidence, create scenarios, run a seeded Monte Carlo stress test, and stage a recommendation through structured page tools.

The human sees every action in the same workspace and can edit or undo it. Most importantly, Forkcast exposes no tool that commits the final decision. Commitment is a deliberate, visible human action.

## How we built it

Forkcast is a dependency-free static PWA using semantic HTML, modern CSS, and JavaScript modules. The WebMCP layer registers JSON-Schema-described tools with the browser model context and uses an AbortController to refresh registrations as the workspace changes. A built-in Tool Lab invokes the same handlers when native WebMCP is unavailable.

The decision engine normalizes criterion weights, layers sparse scenario overrides over base evidence, calculates rankings, identifies low-confidence evidence gaps, and runs deterministic Monte Carlo simulations. Workspace state stays in localStorage and the app shell is cached by a service worker.

## Challenges

The hardest design problem was not adding more agent powers; it was deciding where those powers must stop. We made the final commitment boundary structural rather than instructional: the tool simply does not exist. After a human commits, mutation tools are removed from the registry.

We also designed the preview path so judges can inspect every tool and execute it without requiring an experimental browser build, while preserving the native WebMCP path as the primary integration.

## Accomplishments

- A useful WebMCP workflow rather than a one-shot demo tool.
- Shared state between human controls and agent tools.
- Explicit evidence quality and uncertainty modeling.
- Scenario analysis that preserves the base case.
- Seeded, reproducible stress testing.
- Local-first privacy and offline support.
- A tested human-control boundary with no agent commitment tool.

## What we learned

WebMCP is most powerful when tools map to meaningful domain operations, not low-level clicks. Rich tool descriptions and strict schemas help an agent plan, but a good agentic product also needs visible state, reversible actions, and clear authority boundaries.

## What's next

Future versions could add collaborative workspaces, signed evidence sources, reusable decision templates, sensitivity charts, and organization-level decision policies while preserving the human commitment boundary.
