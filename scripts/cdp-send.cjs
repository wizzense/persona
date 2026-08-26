"use strict";
/* CDP drive of the chat composer: focus the input, type with the Input
 * domain (real keystrokes — React's onChange fires), then click Send with a
 * real mouse event. Usage:
 *   node scripts/cdp-send.cjs <wsUrl> '<text>'
 */
const wsUrl = process.argv[2];
const text = process.argv[3];
if (!wsUrl || !text) {
  console.error("usage: node cdp-send.cjs <wsUrl> <text>");
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
    const focus = await call("Runtime.evaluate", {
      expression: "(() => { const i = document.querySelector('.chat-input'); if (!i) return 'no input'; i.focus(); return 'focused'; })()",
      returnByValue: true,
    });
    console.log("focus:", JSON.stringify(focus.result.value));
    await call("Input.insertText", { text });
    await new Promise((r) => setTimeout(r, 400));
    const rect = await call("Runtime.evaluate", {
      expression: "(() => { const b = document.querySelector('.chat-send'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()",
      returnByValue: true,
    });
    const { x, y } = rect.result.value;
    console.log("send button at:", x, y);
    await call("Input.dispatchMouseEvent", {
      type: "mousePressed", x, y, button: "left", clickCount: 1,
    });
    await call("Input.dispatchMouseEvent", {
      type: "mouseReleased", x, y, button: "left", clickCount: 1,
    });
    console.log("clicked send");
    ws.close();
  } catch (e) {
    console.error("drive failed:", e.message);
    process.exit(1);
  }
};
