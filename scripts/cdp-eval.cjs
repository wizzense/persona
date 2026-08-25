"use strict";
/* Minimal CDP driver for the live Desk renderer. Usage:
 *   node scripts/cdp-eval.cjs <wsUrl> '<JS expression>'
 * Connects, evaluates, prints the result JSON. Node >=22 (global WebSocket).
 */
const wsUrl = process.argv[2];
const expression = process.argv[3];
if (!wsUrl || !expression) {
  console.error("usage: node cdp-eval.cjs <wsUrl> <expression>");
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
    const result = await call("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    console.log(JSON.stringify(result.result.value, null, 2));
    ws.close();
    process.exit(0);
  } catch (err) {
    console.error("EVAL FAILED:", err.message);
    process.exit(1);
  }
};
setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 15000);
