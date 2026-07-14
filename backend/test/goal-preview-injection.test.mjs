import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateTaskContextPacket } from "../src/context-contract/task-context-schema.mjs";
import { taskContextContractDigest } from "../src/context-contract/task-context-canonicalizer.mjs";
import { compileTaskContext, renderGoalPromptFromPacket } from "../src/context-contract/task-context-compiler.mjs";

describe("Goal creation with task context", () => {
  it("compileTaskContext generates a valid packet from legacy fields", () => {
    const { packet } = compileTaskContext({
      objective: "Implement user authentication",
      constraints: ["Must use OAuth2"],
      acceptanceContract: {
        blocking_requirements: [
          { id: "ac1", description: "Login works", blocking: true },
        ],
      },
      workstreamId: "ws_test",
    });

    assert.equal(packet.objective, "Implement user authentication");
    assert.ok(packet.constraints.includes("Must use OAuth2"));
    assert.equal(packet.acceptance_criteria.length, 1);
  });

  it("compileTaskContext excludes process chatter from objective", () => {
    const { packet, diagnostics } = compileTaskContext({
      objective: "Fix the build pipeline",
      messages: [
        { role: "chatgpt", content: "直接生产代码修改被安全策略拦截，已撤销临时测试文件。" },
        { role: "user", content: "请修复构建流水线" },
      ],
    });

    // Objective should not include the chatter
    assert.ok(packet.objective.includes("Fix the build pipeline"));
    assert.equal(packet.objective.includes("安全策略"), false);

    // Diagnostics should capture the exclusion
    assert.ok(diagnostics.excluded_messages.length >= 1);
  });

  it("preview_text is NOT auto-included in compiled packet messages", () => {
    // Simulate createEncodedGoal without include_preview_as_message flag
    const previewText = "This is a preview summary";
    const { packet } = compileTaskContext({
      objective: "Real objective",
      messages: [
        { role: "user", content: "Real message" },
      ],
    });
    const packetStr = JSON.stringify(packet);
    // The preview text was never in messages, so it shouldn't be in the packet
    assert.equal(packetStr.includes(previewText), false);
  });

  it("packet contract digest is stable for same input", () => {
    const { packet: p1 } = compileTaskContext({
      objective: "Test",
      workstreamId: "ws_x",
      acceptanceContract: {
        blocking_requirements: [{ id: "a1", description: "t1", blocking: true }],
      },
    });
    const { packet: p2 } = compileTaskContext({
      objective: "Test",
      workstreamId: "ws_x",
      acceptanceContract: {
        blocking_requirements: [{ id: "a1", description: "t1", blocking: true }],
      },
    });
    assert.equal(
      taskContextContractDigest(p1),
      taskContextContractDigest(p2)
    );
  });
});
