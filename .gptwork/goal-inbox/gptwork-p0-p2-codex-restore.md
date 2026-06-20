# Restore GPTWork P0-P2 Codex Goal ZIP

Payload file:

```text
.gptwork/goal-inbox/gptwork-p0-p2-codex-goal.zip.b64
```

Expected SHA256 after decode:

```text
569ba4ccb00c2d9b1e962e5a7f7b897d96eb6ce9b2dbfc7d96d6570946f33c80
```

Restore commands:

```bash
cd /home/a9017/mcp/workspace/gpt-codex-workspace
base64 -d .gptwork/goal-inbox/gptwork-p0-p2-codex-goal.zip.b64 > /tmp/gptwork-p0-p2-codex-goal.zip
sha256sum /tmp/gptwork-p0-p2-codex-goal.zip
unzip -o /tmp/gptwork-p0-p2-codex-goal.zip -d /tmp/gptwork-p0-p2-codex-goal
cat /tmp/gptwork-p0-p2-codex-goal/goal.md
```

Then execute the goal in `goal.md`.
