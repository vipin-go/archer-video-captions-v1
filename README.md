# archer-video-captions-v1

Portable Gabriel Operator workflow definition for Archer's `/video-captions` slash command.

Clones [browser-use/video-use](https://github.com/browser-use/video-use) into a sandboxed `coding_agent` step (Claude Code, E2B sandbox) to edit real, user-supplied event footage — burning in a title and word-level, speech-synced captions (ElevenLabs Scribe transcription) on top of video-use's own filler-word removal and color-grading passes.

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

This workflow assumes the workspace already has an E2B sandbox provider and an ElevenLabs generation-provider credential configured — both resolved server-side by `resourceKey`/provider id, never stored in this repo.
