import http from "node:http";
import { execSync } from "node:child_process";
import { handleHttp } from "./http-handler.mjs";

export async function listenHttp(server, { host = "127.0.0.1", port = 8787 } = {}) {
  const httpServer = http.createServer((req, res) => handleHttp(req, res, server));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        httpServer.once("error", reject);
        httpServer.listen(port, host, () => {
          httpServer.removeListener("error", reject);
          resolve();
        });
      });
      return httpServer;
    } catch (err) {
      if (err.code !== "EADDRINUSE") throw err;
      try { execSync("lsof -ti :" + port + " 2>/dev/null | xargs kill -9 2>/dev/null"); } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  throw new Error("Could not listen on port " + port + " after 5 retries");
}
