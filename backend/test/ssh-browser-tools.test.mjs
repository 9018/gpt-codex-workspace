import test from "node:test";
import assert from "node:assert/strict";
import { buildSshExecCommand } from "../src/ssh-adapter.mjs";
import { createBrowserRegistry } from "../src/browser-http.mjs";

test("buildSshExecCommand wraps cwd and command for a configured SSH workspace", () => {
  const built = buildSshExecCommand({
    host: "10.0.1.103",
    port: 22,
    user: "a9017",
    root: "/home/a9017/project"
  }, "npm test", "subdir");

  assert.equal(built.file, "ssh");
  assert.ok(built.args.includes("BatchMode=yes"));
  assert.ok(built.args.includes("StrictHostKeyChecking=accept-new"));
  assert.ok(built.args.includes("PreferredAuthentications=publickey"));
  assert.ok(built.args.includes("PasswordAuthentication=no"));
  assert.ok(built.args.includes("-p"));
  assert.ok(built.args.includes("22"));
  assert.ok(built.args.includes("a9017@10.0.1.103"));
  assert.match(built.args.at(-1), /cd '\/home\/a9017\/project\/subdir' && npm test/);
});

test("buildSshExecCommand prefers identity files and only proxies non-10/8 hosts", () => {
  const lan = buildSshExecCommand({
    host: "10.20.30.40",
    port: 22,
    user: "deploy",
    root: "/srv/app",
    identity_file: "/home/a9017/.ssh/id_ed25519"
  }, "true", ".");

  assert.ok(lan.args.includes("-i"));
  assert.ok(lan.args.includes("/home/a9017/.ssh/id_ed25519"));
  assert.equal(lan.args.includes("ProxyCommand=nc -x 10.0.1.105:20177 %h %p"), false);

  const publicHost = buildSshExecCommand({
    host: "203.0.113.10",
    port: 22,
    user: "deploy",
    root: "/srv/app",
    identity_file: "/home/a9017/.ssh/id_ed25519"
  }, "true", ".");

  assert.ok(publicHost.args.includes("-i"));
  assert.ok(publicHost.args.includes("/home/a9017/.ssh/id_ed25519"));
  assert.ok(publicHost.args.includes("ProxyCommand=nc -x 10.0.1.105:20177 %h %p"));
});

test("browser registry tracks lightweight HTTP browser sessions", async () => {
  const browser = createBrowserRegistry();
  const session = browser.newSession({ viewport_width: 800, viewport_height: 600 });

  assert.equal(session.viewport.width, 800);

  const state = await browser.goto(session.session_id, "data:text/html,<title>Hello</title><main>World</main>");
  assert.equal(state.title, "Hello");

  const text = browser.getText(session.session_id);
  assert.match(text.text, /World/);
});
