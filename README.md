# archer-video-captions-v1

Portable Gabriel Operator workflow definition for Archer's `/video-captions` slash command.

Runs [browser-use/video-use](https://github.com/browser-use/video-use) — via a real, headless Claude Code CLI inside an E2B sandbox, not a generic single-turn agent — to edit real, user-supplied event footage: cut/edit selection, color grading, word-level speech-synced subtitles (ElevenLabs Scribe transcription), and animation overlays (HyperFrames, Remotion, Manim, or PIL, picked per animation), with true parallel sub-agent rendering for multiple animations. It proposes an editing strategy, pauses for the user's confirmation in chat, then executes.

## How it runs

This is a single `coding_agent` step (`assets/workflow.json`, `sandboxAgentConfig.codingModel: "claude_code"`), invoked by the platform in up to two passes against the same sandbox:

1. **Propose.** The agent inventories the footage (ffprobe, transcription, a packed transcript reading view), pre-scans for problems, and proposes a 4-8 sentence strategy — cut direction, animation plan, grade, subtitle style — asking any clarifying questions it needs in that same message. It writes the proposal to a known in-sandbox path and stops. The platform detects this, snapshots the sandbox (E2B's native whole-filesystem snapshot), and pauses the run — the user sees the proposal in chat and replies.
2. **Execute.** The platform resumes from that exact snapshot with the user's reply attached. The agent builds the cut list (delegating multi-take beat selection to a sub-agent when useful), builds every animation slot in a **parallel** sub-agent (never sequential — video-use's own hard rule), grades per-segment, renders with subtitles burned in last, self-evaluates the rendered output at every cut boundary (up to 3 fix/re-render passes), and writes the final file.

**Cross-run project memory**: `sandboxAgentConfig.projectMemory` is enabled, keyed by a hash of the `footage_url` intake answer. A later `/video-captions` run against the *same* footage URL restores the prior session's sandbox snapshot (cached transcripts, `edit/project.md`, prior decisions) instead of starting from scratch — matching video-use's own per-project memory convention.

None of the pause/resume/snapshot/parallel-sub-agent/project-memory mechanics live in this repo — they're platform capabilities (`coding-agent.factory.ts`, `real-coding-cli.factory.ts`, `task-execution.service.ts`'s decision/resume handling) that any `coding_agent` step with a real `codingModel` can use. This repo only owns the step's prompt content and config.

## Files

- `assets/workflow.json` — the executable workflow definition (schemaVersion 2), bound via `resourceKey: workflow.archer.video-captions-v1`.
- `assets/persona-command.json` — describes how this workflow's repo and persona-archer's own repo jointly own the `/video-captions` slash command.
- `assets/slash-connections.json` — the slash → intake → execution node graph for this command.
- `scripts/validate-workflow.ts` — validates `assets/workflow.json` against the platform's workflow schema. Run with:

  ```
  npm install
  npx tsx scripts/validate-workflow.ts assets/workflow.json
  ```

## Requirements

This workflow assumes the workspace already has an E2B sandbox provider, a coding-runtime credential for `claude_code` (an Anthropic API key, resolved via `CodingRuntimeCredentialService` — falls back to a server-wide key if the caller hasn't configured their own), and an ElevenLabs generation-provider credential configured — all resolved server-side by provider id, never stored in this repo.

## Importing this into another persona

See the Gabriel Operator Docs Gateway's "Import Shared Workflow Command" playbook for the full one-time setup sequence (create → import-workflow → activate → mint a persona API key) that binds `/video-captions` live to this repo's `main` branch — any push here reaches every importer's persona automatically, with no re-import step.
