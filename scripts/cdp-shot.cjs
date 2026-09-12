"use strict";
/* CDP screenshot of a live window. Usage:
 *   node scripts/cdp-shot.cjs <wsUrl> <outPng>
 */
const fs = require("node:fs");
const wsUrl = process.argv[2];
const outPng = process.argv[3];
if (!wsUrl || !outPng) {
  console.error("usage: node cdp-shot.cjs <wsUrl> <outPng>");
  process.exit(2);
}
const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
function call(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
};
ws.onerror = (e) => { console.error("WS error", e.message || e); process.exit(1); };
ws.onopen = async () => {
  try {
    const shot = await call("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(outPng, Buffer.from(shot.data, "base64"));
    console.log("wrote", outPng);
    ws.close();
  } catch (e) {
    console.error("capture failed:", e.message);
    process.exit(1);
  }
};
