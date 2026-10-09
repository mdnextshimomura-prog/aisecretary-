/**
 * LINE から PDF を全部取り出す（設計 10・11）。LINE は偽物の fetch。
 */
import { createHash } from "node:crypto";
import { fetchObiPdfs, dedupeBySha256 } from "../src/lib/obi/fetch-pdfs";
import type { ObiPdfRecord } from "../src/lib/obi/memo";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (!cond) {
    fail++;
    console.log(`❌ ${name} ${d}`);
  } else console.log(`✅ ${name} ${d}`);
};

const T = 1_760_000_000_000;
const U = "U" + "b".repeat(32);
const pdf = (s: string) => new TextEncoder().encode(`%PDF-1.7\n${s}`);
const bigPdf = (n: number) => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("%PDF-"));
  return b;
};
const rec = (id: string, name = `${id}.pdf`): ObiPdfRecord => ({ messageId: id, fileName: name, size: 0, timestamp: T, userId: U });
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const ab = (u8: Uint8Array) => {
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
};

type Behavior = Uint8Array | number | "timeout" | "network";
function makeFetch(map: Record<string, Behavior>, seen: string[], contentLength: Record<string, string> = {}): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const id = String(url).match(/message\/(\d+)\/content$/)?.[1] ?? "";
    seen.push(id);
    if (new Headers(init?.headers).get("authorization") !== "Bearer line-token") {
      return new Response("no", { status: 401 });
    }
    const b = map[id];
    if (b === "timeout") throw new DOMException("timed out", "TimeoutError");
    if (b === "network") throw new TypeError("fetch failed");
    if (typeof b === "number") return new Response("x", { status: b });
    const headers: Record<string, string> = { "content-type": "application/pdf" };
    if (contentLength[id]) headers["content-length"] = contentLength[id];
    return new Response(ab(b), { status: 200, headers });
  }) as typeof fetch;
}
const opts = (fetchImpl: typeof fetch, deadline = T + 30_000, now = () => T) => ({ fetchImpl, lineToken: "line-token", now, deadline });

async function main() {
  {
    const seen: string[] = [];
    const a = pdf("a");
    const b = pdf("b");
    const r = await fetchObiPdfs([rec("1", "図面\nA.pdf"), rec("2")], opts(makeFetch({ "1": a, "2": b }, seen)));
    ok("全部取れたら順番どおりに返す", r.kind === "ok" && r.files.map((f) => f.messageId).join() === "1,2", JSON.stringify(r.kind));
    if (r.kind === "ok") {
      ok("sha256 と大きさを計算する", r.files[0].sha256 === sha(a) && r.files[0].size === a.byteLength);
      ok("送る名前は整える（改行は空白にする）", r.files[0].fileName === "図面 A.pdf", r.files[0].fileName);
    }
    ok("LINE の content の URL を叩く", seen.join() === "1,2");
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1"), rec("2"), rec("3")], opts(makeFetch({ "1": pdf("a"), "2": 404, "3": pdf("c") }, seen)));
    ok("1件でも取れなければ全体をやめる（その名前を返す）", r.kind === "failed" && r.reason === "unavailable" && r.fileName === "2.pdf", JSON.stringify(r));
    ok("やめた後は取りに行かない", seen.join() === "1,2");
  }
  {
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": new TextEncoder().encode("<html>") }, [])));
    ok("%PDF- で始まらなければやめる", r.kind === "failed" && r.reason === "not-pdf");
  }
  {
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": "timeout" }, [])));
    ok("LINE の時間切れは失敗", r.kind === "failed" && r.reason === "timeout");
    const r2 = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": "network" }, [])));
    ok("通信の失敗は失敗", r2.kind === "failed" && r2.reason === "unavailable");
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": pdf("a") }, seen), T - 1));
    ok("締め切りを過ぎていたら取りに行かずに時間切れ", r.kind === "failed" && r.reason === "timeout" && seen.length === 0);
  }
  {
    const r = await fetchObiPdfs([rec("1"), rec("2")], opts(makeFetch({ "1": bigPdf(13_000_000), "2": bigPdf(13_000_000) }, [])));
    ok("取り出した実際のバイト数の合計でも上限を確かめる", r.kind === "too-large" && r.totalBytes === 26_000_000, JSON.stringify(r.kind));
  }
  {
    const seen: string[] = [];
    const r = await fetchObiPdfs([rec("1")], opts(makeFetch({ "1": pdf("a") }, seen, { "1": "30000000" })));
    ok("content-length が上限を超えていたら読まずにやめる", r.kind === "too-large");
  }
  {
    // Content-Length の無い、終わりの無い応答（1,000,000 バイトずつ流れてくる）
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(1_000_000);
    chunk.set(new TextEncoder().encode("%PDF-"));
    const endless: typeof fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls++;
            controller.enqueue(chunk.slice());
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "application/pdf" } }
      )) as typeof fetch;
    const r = await fetchObiPdfs([rec("1")], opts(endless));
    ok("Content-Length が無くても、読んだ量が上限を超えた所でやめる", r.kind === "too-large" && r.totalBytes === 26_000_000, JSON.stringify(r.kind === "too-large" ? r.totalBytes : r.kind));
    ok("上限を超えた後は読み続けない（流れを止める）", cancelled && pulls <= 28, `pulls=${pulls}`);
  }
  {
    // 前の PDF で使った分を差し引いた残りで止める
    let pulls = 0;
    const chunk = new Uint8Array(1_000_000);
    chunk.set(new TextEncoder().encode("%PDF-"));
    const first = bigPdf(20_000_000);
    const mixed: typeof fetch = (async (url: string | URL | Request) =>
      String(url).includes("/1/")
        ? new Response(ab(first), { status: 200 })
        : new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                pulls++;
                controller.enqueue(chunk.slice());
              },
            }),
            { status: 200 }
          )) as typeof fetch;
    const r = await fetchObiPdfs([rec("1"), rec("2")], opts(mixed));
    ok("2件目は残り（5,000,000 バイト）を超えた所でやめる", r.kind === "too-large" && r.totalBytes === 26_000_000 && pulls <= 8, `pulls=${pulls}`);
  }
  {
    const r = await fetchObiPdfs([rec("1"), rec("2"), rec("3")], opts(makeFetch({ "1": pdf("same"), "2": pdf("other"), "3": pdf("same") }, [])));
    const d = r.kind === "ok" ? dedupeBySha256(r.files) : [];
    ok("同じ中身は先に出たものを残して1つに", d.map((f) => f.messageId).join() === "1,2", d.map((f) => f.messageId).join());
  }

  console.log(fail === 0 ? "\n🎉 全て通過" : `\n⚠️ ${fail}件 失敗`);
  process.exit(fail ? 1 : 0);
}
main();
