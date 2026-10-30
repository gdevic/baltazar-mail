// Print page: receives the messages to print from the main page through chrome.storage.session.
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = a => a?.name ? `${a.name} <${a.email}>` : (a?.email || "");
const fmtList = l => (l || []).map(fmt).join(", ");

(async () => {
  const key = new URLSearchParams(location.search).get("job");
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) { document.getElementById("info").textContent = "Nothing to print (the job has expired)."; return; }
  chrome.storage.session.remove(key);
  const pages = document.getElementById("pages");
  for (const m of job.messages) {
    const h = m.headers || {};
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<div class="hdr"><h1>${esc(h.subject || "(no subject)")}</h1><table>
      <tr><td>From</td><td>${esc(fmtList(h.from))}</td></tr>
      <tr><td>To</td><td>${esc(fmtList(h.to))}</td></tr>
      ${h.cc?.length ? `<tr><td>Cc</td><td>${esc(fmtList(h.cc))}</td></tr>` : ""}
      <tr><td>Date</td><td>${esc(new Date(Number(h.date) * 1000).toLocaleString())}</td></tr></table>
      ${m.attachments?.length ? `<div class="att">Attachments: ${m.attachments.map(a => esc(a)).join(", ")}</div>` : ""}</div>
      <div class="body"></div>`;
    // Body HTML was sanitised by the main page; scripts are additionally blocked by the extension CSP.
    el.querySelector(".body").innerHTML = m.html;
    pages.appendChild(el);
  }
  document.title = job.messages.length === 1 ? (job.messages[0].headers?.subject || "Print") : `${job.messages.length} messages`;
  document.getElementById("info").textContent = `${job.messages.length} message${job.messages.length === 1 ? "" : "s"}; Save as PDF is in the print dialog.`;
  document.getElementById("print").onclick = () => print();
  const imgs = [...document.images];
  await Promise.all(imgs.map(i => i.complete ? null : new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 4000); })));
  if (job.auto && !navigator.webdriver) print();
})();
