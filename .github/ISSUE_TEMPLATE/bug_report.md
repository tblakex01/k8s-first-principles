---
name: 🐛 Bug report
about: A mechanism behaves incorrectly, the sim crashes, or the visualization is wrong
title: "[bug] "
labels: bug
assignees: ''
---

## What happened

<!-- A clear description of the incorrect behavior. -->

## What you expected

<!-- What should have happened, and — if it's a fidelity bug — the ground-truth
     Kubernetes behavior it should match. -->

## Reproduction

The simulation is **deterministic**, so a seed + parameters fully specify a run.

- **Seed** (from the Reset button / `__reset(seed)`): <!-- e.g. 42 -->
- **Preset or slider values:** <!-- e.g. Overcommitted bin-pack; or ratio 3.0×, nodes 6, soft 512Mi -->
- **Steps:** <!-- what you did, e.g. "ran ~600 ticks, injected a leak at t=120s" -->

## Environment

- Browser / Node version:
- `index.html` opened via `file://` or served? 

## Screenshots / event log

<!-- If visual, a screenshot helps. Pasting the relevant event-log lines is great. -->
