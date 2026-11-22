/**
 * 画像のあとの名指し：本物のつなぎ（photo-ask-wire.ts）を、通信を差し替えて通す。
 * 1枚でも取れなければ例外（一部だけで判定しない）・ログに画像の ID を出さない・push は X-Line-Retry-Key つき。
 */
import { loadPhotoAskImages, photoAskDeps, PHOTO_ASK_RETRY_NAMESPACE } from "../src/lib/photo-ask-wire";
import { uuidv5 } from "../src/lib/satei-notify";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
globalThis.fetch = (async () => {
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;
const logs: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn };
const capture = () => {
  console.error = (...a: unknown[]) => logs.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => logs.push(a.map(String).join(" "));
};

type Seen = { url: string; headers: Record<string, string>; body?: string };
function fake(answer: (url: string) => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url: String(url), headers: (init.headers ?? {}) as Record<string, string>, body: init.body as string | undefined });
    return answer(String(url));
  }) as unknown as typeof fetch;
  return { f, seen };
}
const png = () => new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "image/png" } });

(async () => {
  capture();
  {
    const { f } = fake(() => png());
    const a = await loadPhotoAskImages(["imgA", "imgB"], f);
    ok("取れたら全部を画像の添付に", a.length === 2 && a[0].mediaType === "image/png" && a[0].kind === "image");
  }
  {
    const { f } = fake((u) => (u.includes("imgB") ? new Response("", { status: 404 }) : png()));
    let threw = false;
    try {
      await loadPhotoAskImages(["imgA", "imgB"], f);
    } catch {
      threw = true;
    }
    ok("1枚でも取れなければ例外（一部だけで判定しない）", threw);
  }
  {
    const { f } = fake(() => new Response(new Uint8Array(0), { status: 200, headers: { "content-type": "image/jpeg" } }));
    let threw = false;
    try {
      await loadPhotoAskImages(["imgC"], f);
    } catch {
      threw = true;
    }
    ok("空の画像も例外", threw);
  }
  {
    const { f } = fake(() => new Response("", { status: 500 }));
    let parsed = 0;
    const deps = photoAskDeps("2026年11月22日", { fetchImpl: f, parse: (async () => { parsed++; throw new Error("呼ばれない"); }) as never });
    let threw = false;
    try {
      await deps.read(["imgSecret"], "");
    } catch {
      threw = true;
    }
    ok("read：取れなければ例外・AI を呼ばない", threw && parsed === 0);
  }
  {
    const { f } = fake(() => png());
    let got = 0;
    const deps = photoAskDeps("2026年11月22日", {
      fetchImpl: f,
      parse: (async (_t: string, _d: string, att: unknown[]) => {
        got = att.length;
        return { isTask: true, requestType: "査定書", confidence: 0.8, propertyName: "X", propertyKey: "x" };
      }) as never,
    });
    const r = await deps.read(["imgA"], "");
    ok("read：画像を添えて読み、結果の5項目を返す", got === 1 && r.requestType === "査定書" && r.confidence === 0.8 && r.propertyKey === "x");
  }
  {
    const { f, seen } = fake(() => new Response("{}", { status: 200 }));
    const deps = photoAskDeps("2026年11月22日", { fetchImpl: f });
    const sent = await deps.push("U" + "b".repeat(32), "文", undefined, "img:imgA");
    ok("push は X-Line-Retry-Key（鍵から uuidv5）つき", sent && seen[0].headers["X-Line-Retry-Key"] === uuidv5("img:imgA", PHOTO_ASK_RETRY_NAMESPACE));
    const { f: f409 } = fake(() => new Response("{}", { status: 409 }));
    ok("409（同じ鍵で送り済み）も送れた扱い", await photoAskDeps("x", { fetchImpl: f409 }).push("U" + "b".repeat(32), "文", undefined, "k"));
    const { f: f400 } = fake(() => new Response("{}", { status: 400 }));
    ok("400 は送れなかった扱い", !(await photoAskDeps("x", { fetchImpl: f400 }).push("U" + "b".repeat(32), "文", undefined, "k")));
  }
  ok("ログに画像の ID を出さない", !logs.join("\n").includes("imgB") && !logs.join("\n").includes("imgSecret") && !logs.join("\n").includes("imgA"));
  console.error = orig.error;
  console.warn = orig.warn;

  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
