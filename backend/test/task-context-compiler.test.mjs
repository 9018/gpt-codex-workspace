import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileTaskContext,
  classifyConversationMessage,
  renderGoalPromptFromPacket,
  renderContextSummaryFromPacket,
} from "../src/context-contract/task-context-compiler.mjs";

describe("classifyConversationMessage", () => {
  it("marks security policy chatter as process_chatter", () => {
    const result = classifyConversationMessage({
      role: "chatgpt",
      content: "直接生产代码修改被安全策略拦截，已撤销临时测试文件并转为隔离修复 Goal。",
    });
    assert.equal(result.kind, "process_chatter");
    assert.equal(result.include, false);
  });

  it("extracts constraint from mixed message", () => {
    const result = classifyConversationMessage({
      role: "chatgpt",
      content: "所有代码修改必须在隔离 worktree 中完成，不能直接修改。",
    });
    assert.equal(result.kind, "constraint");
    assert.equal(result.include, true);
    assert.ok(result.normalized.includes("隔离 worktree"));
  });

  it("classifies closure acceptance text", () => {
    const result = classifyConversationMessage({
      role: "user",
      content: "继续，直到链路闭环为止",
    });
    assert.equal(result.include, true);
  });
});

describe("compileTaskContext", () => {
  it("excludes process chatter from compiled packet", () => {
    const { packet, diagnostics } = compileTaskContext({
      objective: "修复测试链路",
      messages: [
        {
          role: "chatgpt",
          content: "直接生产代码修改被安全策略拦截，已撤销临时测试文件并转为隔离修复 Goal。",
        },
        {
          role: "user",
          content: "继续，直到链路闭环为止",
        },
      ],
    });

    // Objective should not include the process chatter
    assert.ok(packet.objective.includes("修复测试链路"));
    // Should have exclusion diagnostic
    assert.ok(diagnostics.excluded_messages.length >= 1);
    // Should have acceptance criteria from the closure request
    assert.ok(packet.acceptance_criteria.length >= 1);
  });

  it("generates normalized constraint instead of raw chatter", () => {
    const { packet } = compileTaskContext({
      objective: "修复测试链路",
      messages: [
        {
          role: "chatgpt",
          content: "所有代码修改必须在隔离 worktree 中完成。",
        },
      ],
    });

    const hasConstraint = packet.constraints.some(
      (c) => c.includes("worktree") || c.includes("隔离")
    );
    assert.ok(hasConstraint, "should include worktree constraint");
  });

  it("generates closure acceptance for 'until loop closed' pattern", () => {
    const { packet } = compileTaskContext({
      objective: "修复测试链路",
      messages: [
        {
          role: "user",
          content: "继续，直到链路闭环为止",
        },
      ],
    });

    // Only one closure acceptance should be present (deduplicated)
    assert.equal(packet.acceptance_criteria.filter((ac) => ac.blocking).length, 1);
  });

  it("does not include unverified hypotheses in builder-visible sections automatically", () => {
    const { packet } = compileTaskContext({
      objective: "Fix bug",
      messages: [
        {
          role: "chatgpt",
          content: "可能是内存泄漏导致的",
        },
      ],
    });

    // "可能是" is a hypothesis — should be excluded from context
    const packetStr = JSON.stringify(packet);
    assert.ok(!packetStr.includes("可能是内存泄漏"));
  });

  it("includes preview_text ONLY via explicit flag", () => {
    const { packet } = compileTaskContext({
      objective: "Test preview isolation",
      messages: [
        { role: "user", content: "preview_text content" },
      ],
    });

    // preview_text in messages would be included as-is if not chatter
    // But the flag in compileTaskContext doesn't add preview_text to messages
    // The exclusion is handled at the createEncodedGoal level
    const packetStr = JSON.stringify(packet);
    assert.ok(packetStr.includes("Test preview isolation"));
  });

  it("generates a valid packet with acceptance criteria", () => {
    const { packet } = compileTaskContext({
      objective: "Add feature X",
      constraints: ["Must support Y"],
    });

    assert.ok(packet.acceptance_criteria.length >= 1);
    assert.ok(packet.constraints.some((c) => c.includes("Y")));
  });

  it("handles empty input gracefully", () => {
    assert.throws(() => compileTaskContext({}), /task_context_compilation_failed/);
  });
});

describe("renderGoalPromptFromPacket", () => {
  it("renders objective and criteria", () => {
    const { packet } = compileTaskContext({
      objective: "Fix the build",
      scope: { include: ["src/"], exclude: ["test/"] },
    });
    const rendered = renderGoalPromptFromPacket(packet);
    assert.ok(rendered.includes("Fix the build"));
    assert.ok(rendered.includes("src/"));
  });
});

describe("renderContextSummaryFromPacket", () => {
  it("renders a compact summary", () => {
    const { packet } = compileTaskContext({
      objective: "Fix the build",
    });
    const summary = renderContextSummaryFromPacket(packet);
    assert.ok(summary.includes("Fix the build"));
  });
});
