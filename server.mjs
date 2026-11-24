import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.mjs";

const html = await readFile(new URL("./index.html", import.meta.url), "utf8");
const port = Number(process.env.PORT || 3000);

createServer(createApp({ html })).listen(port, "127.0.0.1", () => {
  console.log(`Сервис запущен: http://127.0.0.1:${port}`);
});
