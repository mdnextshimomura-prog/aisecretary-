/**
 * Googleマップのリンクから住所を取り出す。
 *
 * 社長は物件を**マップのリンクだけ**で送ってくることが多い（履歴で55件）。
 * リンクのままだと「どの物件か」が分からず、担当者が毎回聞き返すことになる。
 * 短縮URLのリダイレクト先に住所が入っているので、それを解決して依頼文に足す。
 *
 * 実測での戻り値の例：
 *   「〒562-0022 大阪府箕面市粟生間谷東５丁目１５−４ 間谷ハイツ」（建物名まで取れる）
 *   「1-chōme-28-1 Higashitoyonakachō, Toyonaka, Osaka 560-0003」（ローマ字のこともある）
 *
 * ★安全のため、**Googleマップのホストにしか行かない**。
 * メッセージに書かれたURLを何でも開くと、外部から踏ませたい先へ
 * サーバーを誘導できてしまう。許可リスト方式にしてある。
 */

const MAP_HOSTS = new Set([
  "maps.app.goo.gl",
  "goo.gl",
  "maps.google.com",
  "www.google.com",
  "google.com",
]);

/** そのURLがGoogleマップとして開いてよいものか */
function isMapUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return false;
    if (!MAP_HOSTS.has(u.hostname)) return false;
    // google.com 系はマップのパスに限る（検索やログイン画面へ行かせない）
    if (u.hostname.endsWith("google.com") && !u.pathname.startsWith("/maps")) {
      return u.hostname === "maps.google.com";
    }
    if (u.hostname === "goo.gl" && !u.pathname.startsWith("/maps")) return false;
    return true;
  } catch {
    return false;
  }
}

/** メッセージ本文からマップのURLを拾う（最大2件） */
export function extractMapUrls(text: string): string[] {
  const urls = text.match(/https:\/\/[^\s、。）」]+/g) ?? [];
  return urls.filter(isMapUrl).slice(0, 2);
}

/** リダイレクト先の q= から住所を取り出す */
function addressFromUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    const q = u.searchParams.get("q");
    if (q && !/^-?\d+\.\d+,-?\d+\.\d+$/.test(q)) return q.trim();
    // /maps/place/<名前>/ の形にも入っている
    const m = u.pathname.match(/\/maps\/place\/([^/]+)/);
    if (m) return decodeURIComponent(m[1]).replace(/\+/g, " ").trim();
    return null;
  } catch {
    return null;
  }
}

/**
 * 短縮URLを追いかけて住所を得る。
 * 失敗しても例外にしない（住所が取れないだけで、依頼の登録は続ける）。
 */
export async function resolveMapUrl(
  url: string,
  timeoutMs = 4000
): Promise<string | null> {
  if (!isMapUrl(url)) return null;
  let current = url;

  // 短縮URLが別の短縮URLを指すこともあるので数回だけ追う
  for (let hop = 0; hop < 3; hop++) {
    const direct = addressFromUrl(current);
    if (direct) return direct;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          // 日本語の住所で返させる。既定だとローマ字になることがある
          "Accept-Language": "ja-JP,ja;q=0.9",
          "User-Agent": "Mozilla/5.0 (compatible; MDNEXT-AI-Secretary/1.0)",
        },
      });
      const loc = res.headers.get("location");
      if (!loc) return null;
      // 転送先も許可リストの中でなければ追わない
      const next = new URL(loc, current).toString();
      if (!isMapUrl(next)) return null;
      current = next;
    } catch (err) {
      console.error("[maps] リンクの解決に失敗:", err);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return addressFromUrl(current);
}

/**
 * 本文中のマップURLを解決し、解析にかける用の補足テキストを返す。
 * 解決できなければ空文字（本文はそのまま使う）。
 */
export async function mapContext(text: string): Promise<string> {
  const urls = extractMapUrls(text);
  if (urls.length === 0) return "";
  const found: string[] = [];
  for (const u of urls) {
    const addr = await resolveMapUrl(u);
    if (addr) found.push(addr);
  }
  if (found.length === 0) return "";
  return `\n（地図リンクの場所: ${found.join(" / ")}）`;
}
