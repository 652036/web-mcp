# Forkcast demo script

## 2–3 minute walkthrough

### 1. Frame the problem — 20 seconds

Open the product-launch example. Explain that the page is the source of truth: three launch alternatives, weighted criteria, evidence, confidence, assumptions, and scenarios are all visible.

### 2. Show the agent interface — 35 seconds

Open **Tool Lab** and run:

```json
{}
```

with `decision_read_workspace`. Point out that the agent receives structured ids, rankings, gaps, and recommendation state instead of scraping page text.

Run `decision_find_evidence_gaps` to show that uncertainty is explicit.

### 3. Collaborate on the decision — 55 seconds

Run `decision_add_option`:

```json
{
  "name": "Partner-led launch",
  "description": "Launch with a specialist distribution partner."
}
```

Read the returned option id, then use `decision_score_option` to record one score with confidence and an evidence note. The matrix and ranking update immediately in the visible page.

Create a scenario with `decision_create_scenario`, activate it, and change a criterion weight. Emphasize that the base case is preserved.

### 4. Stress uncertainty — 30 seconds

Run `decision_run_stress_test` with 2,000 iterations. Show win rates and P10–P90 score ranges. Explain that low-confidence cells vary more than well-supported cells.

### 5. Cross the control boundary — 35 seconds

Run `decision_stage_recommendation`. The recommendation appears in the visible Decision gate.

Point out that the tool list contains no final-commit action. Check the human review box and press **Commit decision** manually. Mutation tools then disappear, leaving only read, focus, gap, and export tools.

### Closing line

“Forkcast gives an agent meaningful operating authority without hiding the reasoning or surrendering the final human decision.”
