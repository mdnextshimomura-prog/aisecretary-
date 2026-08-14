/**
 * メンバー名簿 — LINEの表示名を会社の正式氏名に正規化する。
 *
 * 背景（2026-08-14 の実測）:
 *   LINEの表示名をそのまま担当者に入れていたため、Notionのセレクトに21個の
 *   選択肢が増殖し、同一人物が複数表記で散っていた。
 *     有吉勇弥　Yuya Ariyoshi / ゆうや / 有吉
 *     前田 誠治seiji maeda・メイン / 前田 / 前田社長
 *   これでは集計も振り分けも成立しない。
 *
 * 設計:
 *   - 人の同定は **LINE userId** を軸にする。表示名は本人がいつでも変えられるが
 *     userId は変わらない。1人が複数アカウントを持つ場合はカンマ区切りで並べる。
 *   - 名簿は Notion に置く（人が画面から直せる。コード変更もデプロイも要らない）。
 *   - **名簿が引けない時は元の名前をそのまま使う**（fail-open）。
 *     名簿の障害でタスク登録そのものが止まる方が損失が大きい。
 */
import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const MEMBERS_DB_ID = process.env.NOTION_MEMBERS_DATABASE_ID ?? "";

export interface Member {
  name: string; // 正式氏名（Notionの担当者欄に入る唯一の表記）
  userIds: string[];
  aliases: string[]; // 呼ばれ方（表示名・略称）
  email: string | null;
  active: boolean; // 在籍
  external: boolean; // 社外
}

// Notionへの往復をメッセージごとに行うと遅くなるため短時間だけ持つ。
// 名簿を直してから反映まで最大5分。即座に反映したい時は再デプロイで消える。
const CACHE_TTL_MS = 5 * 60 * 1000;
let cache: { at: number; members: Member[] } | null = null;

/** 全角/半角・数学用英数字記号・敬称・空白のゆれを吸収して比較用の形にする */
export function normalizeName(s: string): string {
  return (s ?? "")
    // 𝐴𝑦𝑢 のような数学用英数字記号を通常の英字に寄せる（NFKCが変換する）
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s　]/g, "")
    .replace(/(さん|様|君|くん|ちゃん|社長|部長|課長|専務|常務)$/, "");
}

function splitList(s: string): string[] {
  return (s ?? "")
    .split(/[,、，]/)
    .map((v) => v.trim())
    .filter(Boolean);
}

export async function loadMembers(): Promise<Member[]> {
  if (!MEMBERS_DB_ID) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.members;

  const res = await notion.databases.query({
    database_id: MEMBERS_DB_ID,
    page_size: 100,
  });

  const members: Member[] = res.results.map((page) => {
    const props =
      ((page as Record<string, unknown>).properties as Record<string, unknown>) ??
      {};
    const title = (props["氏名"] as { title: Array<{ plain_text: string }> })
      ?.title;
    const rich = (key: string) =>
      ((props[key] as { rich_text: Array<{ plain_text: string }> } | undefined)
        ?.rich_text ?? [])
        .map((t) => t.plain_text)
        .join("");
    const sel = (key: string) =>
      (props[key] as { select: { name: string } | null } | undefined)?.select
        ?.name ?? null;

    return {
      name: title?.[0]?.plain_text ?? "",
      userIds: splitList(rich("LINE userId")),
      aliases: splitList(rich("呼ばれ方")),
      email: (props["メール"] as { email: string | null } | undefined)?.email ?? null,
      active: sel("在籍") !== "退職",
      external: sel("区分") === "社外",
    };
  });

  cache = { at: Date.now(), members: members.filter((m) => m.name) };
  return cache.members;
}

/**
 * 担当者を名簿に突き合わせる。
 * userId が取れていればそれが最優先（表示名が変わっても追随できる）。
 * 名前しか無い場合は、正式氏名と「呼ばれ方」に対して 完全一致 → 部分一致 の順で照合する。
 */
export async function resolveMember(
  userId: string | null | undefined,
  name: string | null | undefined
): Promise<Member | null> {
  let members: Member[];
  try {
    members = await loadMembers();
  } catch (err) {
    // 名簿が引けなくてもタスク登録は続ける（元の名前が使われる）
    console.error("メンバー名簿の取得に失敗（元の表記のまま続行）:", err);
    return null;
  }
  if (members.length === 0) return null;

  if (userId) {
    const hit = members.find((m) => m.userIds.includes(userId));
    if (hit) return hit;
  }

  const target = normalizeName(name ?? "");
  // 1文字の名前は誤爆する（「原」が「野原」に当たる等）ので照合しない
  if (target.length < 2) return null;

  const candidates = (m: Member) =>
    [m.name, ...m.aliases].map(normalizeName).filter((c) => c.length >= 2);

  const exact = members.find((m) => candidates(m).includes(target));
  if (exact) return exact;

  // 部分一致は「最初に見つかった人」ではなく「最も確からしい人」を選ぶ。
  //
  // 実データで起きた事故: 「有吉勇弥 / Ayu Yamaguchi」という壊れた表記
  // （姓名は有吉さん、ローマ字は山口さんのもの）が、名簿の並び順のせいで
  // 山口さんに割り当たった。単純な find では誤った人に振られる。
  //
  // 日本語の氏名は姓から始まり、LINEの表示名も「姓名　Romaji」の並びなので、
  // **先頭が一致するもの**を最優先し、その中で最も長く一致するものを採る。
  const score = (c: string): number => {
    if (target.startsWith(c) || c.startsWith(target)) return 1000 + c.length;
    if (target.includes(c) || c.includes(target)) return c.length;
    return 0;
  };

  let best: { member: Member; score: number } | null = null;
  for (const m of members) {
    const s = Math.max(0, ...candidates(m).map(score));
    if (s > 0 && (!best || s > best.score)) best = { member: m, score: s };
  }
  return best?.member ?? null;
}

/**
 * 担当者の表記を正式氏名に寄せる。名簿に無ければ元の表記をそのまま返す
 * （新しい人が入った直後に担当者が空になるのを避ける）。
 */
export async function canonicalAssignee(
  userId: string | null | undefined,
  name: string | null | undefined
): Promise<{ name: string | null; userId: string | null }> {
  const member = await resolveMember(userId, name);
  if (!member) return { name: name ?? null, userId: userId ?? null };
  return {
    name: member.name,
    // 名簿にuserIdがあり、今回メンションで取れなかった場合は名簿の1件目で補う
    // （リマインドで@通知を飛ばせるようにするため）
    userId: userId ?? member.userIds[0] ?? null,
  };
}
