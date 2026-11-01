const fs = require("fs"), path = require("path");
const src = fs.readFileSync("smoke.js", "utf8");
// Reuse smoke.js setup up to the first page.goto, then loop themes.
const head = src.split("await page.goto(")[0];
const tail = `
  await page.goto(\`http://localhost:\${port}/mail.html\`);
  await page.waitForSelector("#rows .row");
  await page.keyboard.press("j"); await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.getElementById("r-subject").textContent.length > 0);
  await page.setViewportSize({ width: 1100, height: 520 });
  const ids = await page.evaluate(async () => Object.keys((await import("./themes.js")).THEMES));
  for (const level of [0, 5, 10]) for (const id of ids) {
    await page.evaluate(async ([id, level]) => {
      const m = await import("./themes.js"); m.applyTheme(id, level);
    }, [id, level]);
    await page.screenshot({ path: path.join(__dirname, "..", "out", "shots", id + (level ? "-" + level : "") + ".png") });
  }
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
`;
fs.mkdirSync(path.join(__dirname, "..", "out", "shots"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "themeshots.run.js"), head + tail);
