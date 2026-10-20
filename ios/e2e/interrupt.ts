// Diagnostic for the app-e2e job: sends Stop (Esc) to a session over blimpd's chat socket, as the app does,
// and prints blimpd's reply. Usage: bun ios/e2e/interrupt.ts <session>
const sock = process.env.BLIMPD_SOCKET!;
const token = (await Bun.file(sock.replace(/blimpd\.sock$/, "token")).text()).trim();
const ws = new WebSocket(`ws+unix://${sock}:/sessions/${process.argv[2]}/chat?token=${token}`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data as string);
  if (m.type === "history") ws.send(JSON.stringify({ type: "interrupt", id: "probe-" + Date.now() }));
  else console.log("blimpd:", JSON.stringify(m));
  if (m.type === "ack" || m.type === "error") setTimeout(() => process.exit(0), 1000);
};
setTimeout(() => (console.log("no reply"), process.exit(1)), 15000);
