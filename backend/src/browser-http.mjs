import { randomUUID } from "node:crypto";

export function createBrowserRegistry() {
  const sessions = new Map();

  return {
    newSession({ headless = true, viewport_width = 1365, viewport_height = 768 } = {}) {
      const session = {
        session_id: randomUUID(),
        headless,
        viewport: { width: viewport_width, height: viewport_height },
        url: "about:blank",
        title: "",
        html: "",
        text: "",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      sessions.set(session.session_id, session);
      return session;
    },

    listSessions() {
      return { sessions: [...sessions.values()].map(publicSession) };
    },

    closeSession(session_id) {
      const existed = sessions.delete(session_id);
      return { ok: existed, session_id };
    },

    async goto(session_id, url) {
      const session = getSession(sessions, session_id);
      session.url = url;
      if (url.startsWith("data:text/html,")) {
        session.html = decodeURIComponent(url.slice("data:text/html,".length));
      } else {
        const response = await fetch(url);
        session.html = await response.text();
      }
      session.title = extractTitle(session.html);
      session.text = stripHtml(session.html);
      session.updated_at = new Date().toISOString();
      return publicSession(session);
    },

    currentState(session_id) {
      return publicSession(getSession(sessions, session_id));
    },

    getText(session_id, max_chars = 20000) {
      const session = getSession(sessions, session_id);
      return { session_id, text: session.text.slice(0, max_chars), truncated: session.text.length > max_chars };
    },

    getHtml(session_id, max_chars = 50000) {
      const session = getSession(sessions, session_id);
      return { session_id, html: session.html.slice(0, max_chars), truncated: session.html.length > max_chars };
    },

    extractLinks(session_id, limit = 100) {
      const session = getSession(sessions, session_id);
      const links = [...session.html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis)]
        .slice(0, limit)
        .map((match) => ({ href: match[1], text: stripHtml(match[2]).trim() }));
      return { session_id, links };
    },

    click(session_id, selector) {
      getSession(sessions, session_id);
      return { ok: true, session_id, selector, note: "Lightweight HTTP browser records click requests but does not execute page JavaScript." };
    },

    fill(session_id, selector, text) {
      getSession(sessions, session_id);
      return { ok: true, session_id, selector, text };
    },

    press(session_id, selector, key) {
      getSession(sessions, session_id);
      return { ok: true, session_id, selector, key };
    },

    waitForSelector(session_id, selector) {
      const session = getSession(sessions, session_id);
      const found = session.html.includes(selector.replace(/^[.#]/, ""));
      return { ok: found, session_id, selector };
    },

    scroll(session_id, x = 0, y = 1000) {
      getSession(sessions, session_id);
      return { ok: true, session_id, x, y };
    },

    evaluate(session_id, script) {
      getSession(sessions, session_id);
      return { ok: false, session_id, script, error: "JavaScript evaluation is not available in the lightweight HTTP browser." };
    }
  };
}

function getSession(sessions, session_id) {
  const session = sessions.get(session_id);
  if (!session) throw new Error(`browser session not found: ${session_id}`);
  return session;
}

function publicSession(session) {
  return {
    session_id: session.session_id,
    url: session.url,
    title: session.title,
    viewport: session.viewport,
    created_at: session.created_at,
    updated_at: session.updated_at
  };
}

function extractTitle(html) {
  return /<title[^>]*>(.*?)<\/title>/is.exec(html)?.[1]?.trim() || "";
}

function stripHtml(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
