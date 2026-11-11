/**
 * B2 査定書：satei-wire.ts の案件の読み取りを、本物の Notion Client の経路で確かめる（fetch は偽物。通信なし）。
 * Notion SDK の既定のログは失敗時に error.message（ページ ID を含む）を出すので、satei 用の Client は
 * 何も出さないこと、結果が想定どおりであることを見る。
 */
import { makeSateiNotion, readSateiDealPageReal, readSateiDealReal } from "../src/lib/satei-wire";

let fail = 0;
const ok = (name: string, cond: boolean, d = "") => {
  if (cond) console.log(`✅ ${name}`);
  else {
    fail++;
    console.log(`❌ ${name} ${d}`);
  }
};
let outside = 0;
globalThis.fetch = (async () => {
  outside++;
  throw new Error("このテストで外部へ通信してはいけない");
}) as typeof fetch;

const DEAL = "0123abcd-0123-4567-89ab-0123456789ab";
const PROP = "fedc4321-0123-4567-89ab-0123456789ab";
const DB = "11112222-3333-4444-5555-666677778888";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const notFound = (id: string) =>
  json(404, {
    object: "error",
    status: 404,
    code: "object_not_found",
    message: `Could not find page with ID: ${id}. Make sure the relevant pages and databases are shared with your integration.`,
  });
const dealPage = {
  object: "page",
  id: DEAL,
  parent: { type: "database_id", database_id: DB },
  archived: false,
  in_trash: false,
  properties: {
    案件名: { type: "title", title: [{ plain_text: "テスト案件" }] },
    ID: { type: "unique_id", unique_id: { number: 42 } },
    Driveフォルダ: {
      type: "url",
      url: "https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMnOp",
    },
    物件: { type: "relation", relation: [{ id: PROP }] },
  },
};

/** console.* に出た文字をすべて集める（テストの ok() の行は元の log で出す） */
const printed: string[] = [];
const orig = {
  log: console.log,
  warn: console.warn,
  error: console.error,
  info: console.info,
  debug: console.debug,
};
const capture = () => {
  for (const k of ["log", "warn", "error", "info", "debug"] as const) {
    console[k] = (...a: unknown[]) => {
      printed.push(
        a
          .map((x) =>
            x instanceof Error
              ? `${x.message}`
              : typeof x === "string"
                ? x
                : JSON.stringify(x),
          )
          .join(" "),
      );
    };
  }
};
const release = () => Object.assign(console, orig);
const leaked = (id: string) => {
  const bare = id.replace(/-/g, "");
  return printed.some((l) => l.includes(id) || l.includes(bare));
};

(async () => {
  // 1) 案件ページが 404 → null。ID はどこにも出ない
  {
    let calls = 0;
    const client = makeSateiNotion((async () => {
      calls++;
      return notFound(DEAL);
    }) as typeof fetch);
    printed.length = 0;
    capture();
    let got: unknown = "unset";
    try {
      got = await readSateiDealReal(DEAL, client);
    } finally {
      release();
    }
    ok("案件ページが 404 → null", got === null, String(got));
    ok(
      "偽の fetch を通った（本物の Client の経路）",
      calls === 1,
      String(calls),
    );
    ok(
      "404 のとき console に案件の ID が出ない",
      !leaked(DEAL),
      printed.join(" | "),
    );
  }

  // 2) 案件は読めて物件が 404 → kind は null、物件の ID は出ない
  {
    const client = makeSateiNotion((async (url: string | URL | Request) => {
      const u = String(url);
      return u.includes(PROP) ? notFound(PROP) : json(200, dealPage);
    }) as typeof fetch);
    printed.length = 0;
    capture();
    let g: Awaited<ReturnType<typeof readSateiDealReal>> = null;
    try {
      g = await readSateiDealReal(DEAL, client);
    } finally {
      release();
    }
    ok(
      "物件が 404 → 案件は読めて kind は null",
      !!g &&
        g.kind === null &&
        g.deal.dealNo === 42 &&
        g.deal.parentDbId === DB.replace(/-/g, ""),
      JSON.stringify(g),
    );
    ok(
      "物件が 404 のとき console に ID が出ない",
      !leaked(PROP) && !leaked(DEAL),
      printed.join(" | "),
    );
  }

  // 3) 500（ID を含む文）→ 例外を投げる（呼ぶ側で read-failed）。ID は出ない
  {
    const client = makeSateiNotion((async () =>
      json(500, {
        object: "error",
        status: 500,
        code: "internal_server_error",
        message: `failed for ${DEAL}`,
      })) as typeof fetch);
    printed.length = 0;
    capture();
    let threw = false;
    try {
      await readSateiDealReal(DEAL, client);
    } catch {
      threw = true;
    } finally {
      release();
    }
    ok("500 は例外を投げる", threw);
    ok("500 のとき console に ID が出ない", !leaked(DEAL), printed.join(" | "));
  }

  // 4) 案件ページだけを読む：物件は取りに行かない／404 → null・500 → 例外。ID は出ない
  {
    const urls: string[] = [];
    const client = makeSateiNotion((async (url: string | URL | Request) => {
      urls.push(String(url));
      return json(200, dealPage);
    }) as typeof fetch);
    const d = await readSateiDealPageReal(DEAL, client);
    ok("案件ページだけ読む（物件は取りに行かない）", !!d && d.dealNo === 42 && urls.length === 1, urls.join(","));
    const c404 = makeSateiNotion((async () => notFound(DEAL)) as typeof fetch);
    const c500 = makeSateiNotion((async () =>
      json(500, { object: "error", status: 500, code: "internal_server_error", message: `failed for ${DEAL}` })) as typeof fetch);
    printed.length = 0;
    capture();
    let n: unknown = "unset";
    let threw = false;
    try {
      n = await readSateiDealPageReal(DEAL, c404);
      await readSateiDealPageReal(DEAL, c500);
    } catch {
      threw = true;
    } finally {
      release();
    }
    ok("案件ページ単独：404 → null", n === null);
    ok("案件ページ単独：500 → 例外", threw);
    ok("案件ページ単独：console に ID が出ない", !leaked(DEAL), printed.join(" | "));
  }

  ok("外部への通信は0回", outside === 0, String(outside));
  if (fail > 0) {
    console.log(`\n${fail} 件失敗`);
    process.exit(1);
  }
  console.log("\nすべて成功");
})();
