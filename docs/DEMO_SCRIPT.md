# Forkcast — 2:43 demo

## Before recording

- Use the verified production deployment at `https://forkcast.st2p8g4tkf.chatgpt.site/`, not the GitHub Pages fallback.
- Confirm the badge says **Native WebMCP connected** before starting.
- Load the **Product launch** example and refresh once for a clean history.
- Keep the app and agent side by side at a readable zoom; hide notifications and personal browser data.
- Rehearse with the exact prompts, trim agent wait time, and target a final runtime of 2:40–2:45. Hard stop at 2:50 so the uploaded video is safely under three minutes.

## 0:00–0:15 — The problem

Show the full workspace, then say:

> “Important decisions disappear into AI chats. Forkcast makes the decision model the shared surface: evidence, uncertainty, scenarios, and every action stay inspectable.”

Point to the live ranking, evidence matrix, and activity trail. Do not scroll through every panel.

## 0:15–0:30 — Prove native WebMCP

Point to **Native WebMCP connected** and say:

> “This page registers context-aware tools through `document.modelContext`. The agent uses domain operations, not brittle clicks, and updates the page I see.”

Briefly open the tool list. Note that irrelevant tools are absent and availability changes with workspace state.

## 0:30–0:55 — Read before acting

Ask the agent:

> “Read this Forkcast workspace and identify the two weakest evidence cells. Do not change anything yet.”

The expected calls are `decision_read_workspace` for the compact overview, followed by `decision_find_evidence_gaps` and its `nextCursor` for the two weakest cells. Point out the structured ids, active scenario, leader, and confidence-ranked gaps returned without screen scraping.

Say: “We are reading the same active scenario, and user-authored notes are marked as untrusted tool output.”

## 0:55–1:30 — Collaborate in visible state

Continue:

> “Add ‘Partner-led launch’ as an alternative. Score it 7.5 on the first criterion at 65 percent confidence with evidence ‘Partner committed to a four-week pilot; onboarding capacity is unverified,’ then show me the matrix.”

Expected calls: `decision_add_option`, `decision_score_option`, and `decision_focus_view`.

As the page updates, point to the changed matrix cell and ranking, then the “Last shared action” card and audit trail. Say: “Agent changes are visible and undoable, but agent undo cannot cross a later human edit.”

## 1:30–2:00 — Stress the recommendation

Ask:

> “Run 2,000 simulations with seed 20260828 and summarize whether the leader is robust.”

The expected call is `decision_run_stress_test`. Show win rate, expected score, and the P10–P90 range.

Say: “Low-confidence evidence gets wider variance, and the fixed seed makes this reproducible.”

## 2:00–2:35 — Cross the authority boundary

Ask the agent:

> “Stage the current leader with a concise rationale for my review.”

The expected call is `decision_stage_recommendation`. Point to the visible Decision gate and say: “The WebMCP agent can prepare a recommendation, but the site-tool surface has no commit or finalize operation.”

Personally check the review box and press **Commit decision**. Reopen the tool list and show that only four read/focus/export tools remain; visible editing controls are disabled.

## 2:35–2:43 — Close

> “Forkcast gives an agent meaningful analytical authority without hiding its work or surrendering the human decision.”

## Deterministic fallback for rehearsal

The built-in Tool Lab invokes the exact same schemas and handlers and is useful for rehearsal or debugging. The submitted video should still show the native badge and a real browser-agent tool call so the WebMCP integration is unmistakable.
